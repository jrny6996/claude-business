import { describe, expect, it } from "vitest";
import { normalizeImageUrl } from "./extract.js";
import { fromDomProduct } from "./normalize.js";
import { scrapeProduct, type PageSource } from "./index.js";

/**
 * Captured from a live AliExpress PDP (September 2026), which is the only
 * reliable way to know these selectors. The class names are content-hashed
 * (`price-default--current--F8OlYIo`), so the stable part is the middle
 * segment — an earlier version matched `price--current` and silently found
 * nothing, which is what made every scrape fail with "no product data".
 */
const REAL_DOM = {
  title:
    "PAGANI DESIGN Moon Mens Watches 2025 Top Brand Luxury Quartz Watch For Men Chronograph Luminous Sapphire Mirror Waterproof Clock",
  priceText: "$69.54",
  compareAtText: "$160.28",
  ratingText: "4.8",
  ratingCountText: "55 Reviews",
  shipsFrom: "Free shipping · Ship from United States",
  highlights: [
    "Luxury quartz watch with premium design The PAGANI DESIGN Moon Mens Watch features a sleek round case",
    "High-quality sapphire crystal dial window",
  ],
  variants: [
    { id: "14-100005979", options: { Color: "Dark Blue" }, available: true },
    { id: "14-100013777", options: { Color: "Red Black" }, available: false },
  ],
  images: [
    "https://ae-pic-a1.aliexpress-media.com/kf/S23af1ba081af4edeba4e1c7f65fe33fcN.jpg_220x220q75.jpg_.avif",
    "https://ae-pic-a1.aliexpress-media.com/kf/S1c984f5aa837481d9e8111a518e93da5S.jpg_220x220q75.jpg_.avif",
  ],
};

describe("normalizeImageUrl on live CDN URLs", () => {
  it("strips both the resize suffix and the .avif format hint", () => {
    expect(
      normalizeImageUrl(
        "https://ae-pic-a1.aliexpress-media.com/kf/S23af1ba081af4edeba4e1c7f65fe33fcN.jpg_220x220q75.jpg_.avif",
      ),
    ).toBe(
      "https://ae-pic-a1.aliexpress-media.com/kf/S23af1ba081af4edeba4e1c7f65fe33fcN.jpg",
    );
  });

  it("still handles the older resize-only form", () => {
    expect(normalizeImageUrl("//ae01.alicdn.com/kf/a.jpg_640x640q90.jpg")).toBe(
      "https://ae01.alicdn.com/kf/a.jpg",
    );
  });
});

describe("fromDomProduct on the real PDP", () => {
  const raw = fromDomProduct(REAL_DOM);

  it("reads the title", () => {
    expect(raw.title).toContain("PAGANI DESIGN Moon Mens Watches");
  });

  it("reads the current and original prices", () => {
    expect(raw.priceCents).toBe(6954);
    expect(raw.compareAtPriceCents).toBe(16028);
    expect(raw.currency).toBe("USD");
  });

  it("reads the rating and review count", () => {
    expect(raw.ratingAverage).toBe(4.8);
    expect(raw.ratingCount).toBe(55);
  });

  it("pulls just the origin out of the shipping line", () => {
    expect(raw.shipsFrom).toBe("United States");
  });

  it("keeps the AI-overview bullets as highlights", () => {
    expect(raw.highlights).toHaveLength(2);
  });

  it("carries variant options and availability, inheriting the price", () => {
    expect(raw.variants).toEqual([
      {
        id: "14-100005979",
        options: { Color: "Dark Blue" },
        priceCents: 6954,
        available: true,
      },
      {
        id: "14-100013777",
        options: { Color: "Red Black" },
        priceCents: 6954,
        available: false,
      },
    ]);
  });

  it("normalises the gallery images", () => {
    expect(raw.images).toEqual([
      "https://ae-pic-a1.aliexpress-media.com/kf/S23af1ba081af4edeba4e1c7f65fe33fcN.jpg",
      "https://ae-pic-a1.aliexpress-media.com/kf/S1c984f5aa837481d9e8111a518e93da5S.jpg",
    ]);
  });

  it("omits variants when no price was found, rather than inventing one", () => {
    const noPrice = fromDomProduct({ ...REAL_DOM, priceText: null });
    expect(noPrice.variants).toBeUndefined();
  });
});

describe("scrapeProduct from a DOM-only page", () => {
  it("produces a complete product with no page state at all", async () => {
    const pageSource: PageSource = {
      name: "fake",
      load: async () => ({
        html: "<html><head><title></title></head><body></body></html>",
        finalUrl: "https://www.aliexpress.us/item/3256807927372597.html",
        domProduct: REAL_DOM,
      }),
    };

    const product = await scrapeProduct(
      "https://www.aliexpress.com/item/1005010207997718.html",
      { pageSource, now: new Date("2026-09-04T12:00:00.000Z") },
    );

    expect(product.title).toContain("PAGANI DESIGN");
    expect(product.price).toEqual({ amountCents: 6954, currency: "USD" });
    expect(product.compareAtPrice).toEqual({
      amountCents: 16028,
      currency: "USD",
    });
    expect(product.ratingAverage).toBe(4.8);
    expect(product.shipsFrom).toBe("United States");
    expect(product.variants).toHaveLength(2);
    expect(product.images).toHaveLength(2);
    // The .com -> .us gateway rewrites the item id; ours comes from the paste.
    expect(product.sourceId).toBe("1005010207997718");
  });
});
