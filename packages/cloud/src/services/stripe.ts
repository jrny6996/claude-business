import { AppError } from "@repo/shared";

/**
 * Stripe, from *our* side of the business.
 *
 * Worth being clear about what this is and isn't. The Stripe client in
 * `packages/store-generator` is BYOK — the user's key, on the user's machine,
 * for the user's storefront, and we never see it. This one is ours: it sells
 * our own premium subscription with our own key, which is ordinary commerce and
 * has nothing to do with the storefront payment path we deliberately stay out
 * of. No user's Stripe key is ever handled here.
 */
const STRIPE_API = "https://api.stripe.com/v1";

export type FetchLike = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripeSubscription {
  id: string;
  status: string;
  /** Unix seconds the paid period ends. Drives the licence expiry. */
  current_period_end: number;
  customer: string;
}

export interface StripeCheckoutSessionDetails {
  id: string;
  /** Null until Stripe has finished creating the subscription. */
  subscription: string | null;
  customer_email: string | null;
  status: string;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
}

export interface StripePriceDetails {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string; interval_count: number } | null;
}

/** What the routes are allowed to ask Stripe for. */
export interface StripeApi {
  createSubscriptionCheckout(input: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    email?: string;
  }): Promise<StripeCheckoutSession>;
  getSubscription(id: string): Promise<StripeSubscription>;
  getCheckoutSession(id: string): Promise<StripeCheckoutSessionDetails>;
  getCustomer(id: string): Promise<StripeCustomer>;
  getPrice(id: string): Promise<StripePriceDetails>;
  /** Active subscriptions for an email, used for licence recovery. */
  findActiveSubscriptionsByEmail(email: string): Promise<StripeSubscription[]>;
}

export interface StripeClientOptions {
  secretKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class StripeClient implements StripeApi {
  readonly #secretKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor({ secretKey, fetchImpl, timeoutMs = 20_000 }: StripeClientOptions) {
    const key = secretKey.trim();
    if (!key) {
      throw new AppError(
        "CLOUD_REQUEST_FAILED",
        "The licensing service isn't configured to take payments.",
        "STRIPE_SECRET_KEY is not set",
      );
    }
    this.#secretKey = key;
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#timeoutMs = timeoutMs;
  }

  async createSubscriptionCheckout({
    priceId,
    successUrl,
    cancelUrl,
    email,
  }: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    email?: string;
  }): Promise<StripeCheckoutSession> {
    const form: Form = {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // The buyer's email is the licence's identity, so Stripe must collect it
      // even when we don't already know it.
      ...(email ? { customer_email: email } : {}),
    };

    return this.#request<StripeCheckoutSession>("POST", "/checkout/sessions", form);
  }

  async getSubscription(id: string): Promise<StripeSubscription> {
    return this.#request<StripeSubscription>(
      "GET",
      `/subscriptions/${encodeURIComponent(id)}`,
    );
  }

  async getCheckoutSession(id: string): Promise<StripeCheckoutSessionDetails> {
    return this.#request<StripeCheckoutSessionDetails>(
      "GET",
      `/checkout/sessions/${encodeURIComponent(id)}`,
    );
  }

  async getCustomer(id: string): Promise<StripeCustomer> {
    return this.#request<StripeCustomer>(
      "GET",
      `/customers/${encodeURIComponent(id)}`,
    );
  }

  async getPrice(id: string): Promise<StripePriceDetails> {
    return this.#request<StripePriceDetails>(
      "GET",
      `/prices/${encodeURIComponent(id)}`,
    );
  }

  async findActiveSubscriptionsByEmail(
    email: string,
  ): Promise<StripeSubscription[]> {
    const customers = await this.#request<{ data: StripeCustomer[] }>(
      "GET",
      `/customers?email=${encodeURIComponent(email)}&limit=10`,
    );

    const found: StripeSubscription[] = [];
    for (const customer of customers.data ?? []) {
      const subs = await this.#request<{ data: StripeSubscription[] }>(
        "GET",
        `/subscriptions?customer=${encodeURIComponent(customer.id)}&status=active&limit=10`,
      );
      found.push(...(subs.data ?? []));
    }
    return found;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    form?: Form,
  ): Promise<T> {
    if (typeof this.#fetch !== "function") {
      throw new AppError("CLOUD_REQUEST_FAILED", "No network client is available.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${STRIPE_API}${path}`, {
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
        // Stripe's own message is safe to surface — it describes the request,
        // not the key. The key itself is never echoed.
        throw new AppError(
          "CLOUD_REQUEST_FAILED",
          "Stripe couldn't complete that request.",
          stripeErrorMessage(body) ?? `HTTP ${response.status}`,
        );
      }

      return JSON.parse(body) as T;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("CLOUD_REQUEST_FAILED", "Couldn't reach Stripe.");
    } finally {
      clearTimeout(timer);
    }
  }
}

type Form = Record<string, string | number | boolean | undefined>;

function encodeForm(form: Form): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

function stripeErrorMessage(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
  } catch {
    return undefined;
  }
}
