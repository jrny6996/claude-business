import { describe, expect, it } from "vitest";
import { NormalizedProductSchema } from "./product.js";
import { StoreConfigSchema } from "./store.js";
import { SettingsViewSchema } from "./user.js";

describe("NormalizedProductSchema", () => {
  const base = {
    sourceId: "1005006",
    sourceUrl: "https://www.aliexpress.com/item/1005006.html",
    title: "Widget",
    price: { amountCents: 1000, currency: "USD" },
    scrapedAt: "2026-09-04T00:00:00.000Z",
  };

  it("fills defaults for optional collections", () => {
    const parsed = NormalizedProductSchema.parse(base);
    expect(parsed.images).toEqual([]);
    expect(parsed.variants).toEqual([]);
    expect(parsed.compareAtPrice).toBeNull();
    expect(parsed.description).toBe("");
  });

  it("rejects a product with no title", () => {
    expect(() =>
      NormalizedProductSchema.parse({ ...base, title: "" }),
    ).toThrow();
  });

  it("rejects a non-URL source", () => {
    expect(() =>
      NormalizedProductSchema.parse({ ...base, sourceUrl: "not-a-url" }),
    ).toThrow();
  });
});

describe("StoreConfigSchema", () => {
  it("defaults theme and pricing", () => {
    const parsed = StoreConfigSchema.parse({ storeName: "Test" });
    expect(parsed.theme.preset).toBe("minimal");
    expect(parsed.pricing.markupMultiplier).toBe(2.5);
    expect(parsed.pricing.charmPricing).toBe(true);
  });

  it("rejects a malformed accent colour", () => {
    expect(() =>
      StoreConfigSchema.parse({ storeName: "T", theme: { accentColor: "blue" } }),
    ).toThrow();
  });
});

describe("SettingsViewSchema", () => {
  it("models secrets as metadata only", () => {
    const parsed = SettingsViewSchema.parse({
      profile: {
        id: "u1",
        tier: "free",
        createdAt: "2026-09-04T00:00:00.000Z",
      },
      openRouter: { present: true, last4: "ab12" },
      stripe: { present: false, last4: null },
      deployTokens: {},
      backupEnabled: false,
    });
    expect(parsed.openRouter.present).toBe(true);
    expect(Object.keys(parsed.openRouter)).not.toContain("key");
  });
});
