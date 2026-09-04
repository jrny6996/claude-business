import { AppError, StoreConfigSchema, type NormalizedProduct } from "@repo/shared";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../scrape/fetch.js";
import { StripeClient } from "./client.js";
import { provisionStripeCheckout, validateStripeKey } from "./checkout.js";

const product: NormalizedProduct = {
  sourceId: "1005006",
  sourceUrl: "https://www.aliexpress.com/item/1005006.html",
  title: "Wireless Earbuds",
  description: "Nice buds.",
  highlights: [],
  price: { amountCents: 1000, currency: "USD" },
  compareAtPrice: null,
  images: [],
  variants: [
    { id: "v1", options: { Color: "Black" }, priceCents: 1000, available: true },
    { id: "v2", options: { Color: "White" }, priceCents: 1500, available: true },
    { id: "v3", options: { Color: "Red" }, priceCents: 2000, available: false },
  ],
  ratingAverage: null,
  ratingCount: null,
  shipsFrom: null,
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

const config = StoreConfigSchema.parse({
  storeName: "Sound Lab",
  pricing: { markupMultiplier: 2, charmPricing: false, currency: "USD" },
});

/** Records every request and replies with canned Stripe-shaped payloads. */
function fakeStripe() {
  const calls: { url: string; body: string; auth: string; method: string }[] = [];
  let priceCounter = 0;
  let linkCounter = 0;

  const fetchImpl = (async (url: string, init: Record<string, unknown> = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      body: String(init.body ?? ""),
      auth: headers.Authorization ?? "",
      method: String(init.method ?? "GET"),
    });

    const reply = (payload: unknown) => ({
      ok: true,
      status: 200,
      url,
      text: async () => JSON.stringify(payload),
    });

    if (url.endsWith("/products")) return reply({ id: "prod_1" });
    if (url.endsWith("/prices")) return reply({ id: `price_${++priceCounter}` });
    if (url.endsWith("/payment_links")) {
      linkCounter++;
      return reply({
        id: `plink_${linkCounter}`,
        url: `https://buy.stripe.com/link_${linkCounter}`,
      });
    }
    return reply({ data: [] });
  }) as unknown as FetchLike;

  return { fetchImpl, calls };
}

describe("StripeClient", () => {
  it("refuses to construct without a key", () => {
    expect(() => new StripeClient({ secretKey: "   " })).toThrowError(AppError);
  });

  it("sends the key as a bearer token and form-encodes the body", async () => {
    const { fetchImpl, calls } = fakeStripe();
    const client = new StripeClient({ secretKey: "sk_test_123", fetchImpl });
    await client.createPrice("prod_1", 1999, "USD");

    expect(calls[0]?.auth).toBe("Bearer sk_test_123");
    expect(calls[0]?.body).toContain("unit_amount=1999");
    expect(calls[0]?.body).toContain("currency=usd");
  });

  it("enables adjustable quantity on payment links", async () => {
    const { fetchImpl, calls } = fakeStripe();
    const client = new StripeClient({ secretKey: "sk_test_123", fetchImpl });
    const link = await client.createPaymentLink("price_1");

    expect(link.url).toBe("https://buy.stripe.com/link_1");
    expect(calls[0]?.body).toContain("adjustable_quantity");
  });

  it("maps a 401 to a key problem the user can fix", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      url: "",
      text: async () => JSON.stringify({ error: { message: "Invalid API Key" } }),
    })) as unknown as FetchLike;

    const client = new StripeClient({ secretKey: "sk_bad", fetchImpl });
    await expect(client.validateKey()).rejects.toMatchObject({
      code: "MISSING_STRIPE_KEY",
    });
  });

  it("does not leak the key in the thrown error", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 500,
      url: "",
      text: async () => "boom",
    })) as unknown as FetchLike;

    const client = new StripeClient({ secretKey: "sk_test_SUPERSECRET", fetchImpl });
    try {
      await client.validateKey();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(JSON.stringify((error as AppError).toShape())).not.toContain(
        "SUPERSECRET",
      );
    }
  });

  it("surfaces a network failure as a Stripe request failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as FetchLike;

    const client = new StripeClient({ secretKey: "sk_test", fetchImpl });
    await expect(client.validateKey()).rejects.toMatchObject({
      code: "STRIPE_REQUEST_FAILED",
    });
  });
});

describe("provisionStripeCheckout", () => {
  it("creates a product, a price and a payment link", async () => {
    const { fetchImpl, calls } = fakeStripe();
    const checkout = await provisionStripeCheckout(config, product, {
      secretKey: "sk_test_123",
      fetchImpl,
      includeVariants: false,
    });

    expect(checkout.provider).toBe("stripe");
    expect(checkout.stripeProductId).toBe("prod_1");
    expect(checkout.paymentLinkUrl).toBe("https://buy.stripe.com/link_1");
    expect(calls.map((c) => c.url.split("/v1")[1])).toEqual([
      "/products",
      "/prices",
      "/payment_links",
    ]);
  });

  it("prices the base link at the marked-up retail price, not the cost", async () => {
    const { fetchImpl, calls } = fakeStripe();
    await provisionStripeCheckout(config, product, {
      secretKey: "sk_test_123",
      fetchImpl,
      includeVariants: false,
    });

    // 1000 cents cost * 2 markup, charm pricing off.
    expect(calls[1]?.body).toContain("unit_amount=2000");
  });

  it("creates links only for available variants priced differently", async () => {
    const { fetchImpl } = fakeStripe();
    const checkout = await provisionStripeCheckout(config, product, {
      secretKey: "sk_test_123",
      fetchImpl,
    });

    // v1 matches the base price, v3 is unavailable — only v2 earns a link.
    expect(Object.keys(checkout.variantPaymentLinks)).toEqual(["v2"]);
  });

  it("caps how many variant links it will create", async () => {
    const many: NormalizedProduct = {
      ...product,
      variants: Array.from({ length: 50 }, (_, i) => ({
        id: `v${i}`,
        options: { Color: `C${i}` },
        priceCents: 2000 + i,
        available: true,
      })),
    };

    const { fetchImpl } = fakeStripe();
    const checkout = await provisionStripeCheckout(config, many, {
      secretKey: "sk_test_123",
      fetchImpl,
      maxVariantLinks: 3,
    });

    expect(Object.keys(checkout.variantPaymentLinks)).toHaveLength(3);
  });

  it("propagates a missing key as a prompt to add one", async () => {
    await expect(
      provisionStripeCheckout(config, product, { secretKey: "" }),
    ).rejects.toMatchObject({ code: "MISSING_STRIPE_KEY" });
  });
});

describe("validateStripeKey", () => {
  it("returns true for a working key", async () => {
    const { fetchImpl } = fakeStripe();
    await expect(validateStripeKey("sk_test_123", fetchImpl)).resolves.toBe(true);
  });
});
