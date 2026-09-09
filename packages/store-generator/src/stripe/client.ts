import { AppError } from "@repo/shared";
import type { FetchLike } from "../scrape/fetch.js";

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Minimal Stripe REST client.
 *
 * BYOK, and deliberately direct: this runs on the user's own machine with the
 * user's own secret key. We never proxy it, never store it server-side, and
 * never write it into a generated storefront. The only thing that ends up in
 * the store is the resulting Stripe-hosted payment link URL.
 */
export interface StripeClientOptions {
  secretKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface StripeProduct {
  id: string;
}
export interface StripePrice {
  id: string;
}
export interface StripePaymentLink {
  id: string;
  url: string;
}

type Form = Record<string, string | number | boolean | undefined>;

export class StripeClient {
  readonly #secretKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor({ secretKey, fetchImpl, timeoutMs = 20_000 }: StripeClientOptions) {
    const key = secretKey.trim();
    if (!key) {
      throw new AppError(
        "MISSING_STRIPE_KEY",
        "Add your Stripe secret key in Settings to enable checkout.",
      );
    }
    this.#secretKey = key;
    this.#fetch = (fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
    this.#timeoutMs = timeoutMs;
  }

  async createProduct(name: string, description?: string): Promise<StripeProduct> {
    const form: Form = { name: name.slice(0, 250) };
    if (description) form.description = description.slice(0, 500);
    return this.#post<StripeProduct>("/products", form);
  }

  async createPrice(
    productId: string,
    unitAmountCents: number,
    currency: string,
  ): Promise<StripePrice> {
    return this.#post<StripePrice>("/prices", {
      product: productId,
      unit_amount: Math.round(unitAmountCents),
      currency: currency.toLowerCase(),
    });
  }

  async createPaymentLink(
    priceId: string,
    { adjustableQuantity = true }: { adjustableQuantity?: boolean } = {},
  ): Promise<StripePaymentLink> {
    const form: Form = {
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
    };
    if (adjustableQuantity) {
      form["line_items[0][adjustable_quantity][enabled]"] = true;
      form["line_items[0][adjustable_quantity][minimum]"] = 1;
      form["line_items[0][adjustable_quantity][maximum]"] = 99;
    }
    return this.#post<StripePaymentLink>("/payment_links", form);
  }

  /** Cheap authenticated call used to validate a pasted key. */
  async validateKey(): Promise<boolean> {
    await this.#request("GET", "/products?limit=1");
    return true;
  }

  async #post<T>(path: string, form: Form): Promise<T> {
    return this.#request<T>("POST", path, form);
  }

  async #request<T>(method: "GET" | "POST", path: string, form?: Form): Promise<T> {
    if (typeof this.#fetch !== "function") {
      throw new AppError("STRIPE_REQUEST_FAILED", "No network client is available.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await (
        this.#fetch as unknown as (
          input: string,
          init: Record<string, unknown>,
        ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
      )(`${STRIPE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form ? encodeForm(form) : undefined,
        signal: controller.signal,
      });

      const body = await response.text();

      if (!response.ok) {
        throw new AppError(
          response.status === 401
            ? "MISSING_STRIPE_KEY"
            : "STRIPE_REQUEST_FAILED",
          response.status === 401
            ? "Stripe rejected that secret key. Check it in Settings and try again."
            : "Stripe couldn't set up checkout for this store.",
          stripeErrorMessage(body) ?? `HTTP ${response.status}`,
        );
      }

      return JSON.parse(body) as T;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "STRIPE_REQUEST_FAILED",
        "Couldn't reach Stripe. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function encodeForm(form: Form): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

/** Pulls Stripe's own error message out, without echoing the whole payload. */
function stripeErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}
