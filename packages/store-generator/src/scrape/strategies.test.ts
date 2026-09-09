import { AppError } from "@repo/shared";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HTML,
  JSON_LD_HTML,
  NO_PRICE_HTML,
  OPEN_GRAPH_HTML,
  RUN_PARAMS_HTML,
} from "./fixtures.js";
import {
  extractRawProduct,
  fromJsonLd,
  fromOpenGraph,
  fromRunParams,
  mergeRaw,
  toNormalizedProduct,
} from "./normalize.js";
import { parseProductUrl } from "./url.js";

const parsedUrl = parseProductUrl(
  "https://www.aliexpress.com/item/1005006123456789.html",
);
const now = new Date("2026-09-04T12:00:00.000Z");

describe("fromRunParams", () => {
  const raw = fromRunParams(RUN_PARAMS_HTML);

  it("reads the title", () => {
    expect(raw.title).toBe("Wireless Earbuds Pro ANC");
  });

  it("reads the discounted price and the original as compare-at", () => {
    expect(raw.priceCents).toBe(1899);
    expect(raw.compareAtPriceCents).toBe(3999);
    expect(raw.currency).toBe("USD");
  });

  it("normalises and de-duplicates images", () => {
    expect(raw.images).toEqual([
      "https://ae01.alicdn.com/kf/one.jpg",
      "https://ae01.alicdn.com/kf/two.jpg",
      "https://ae01.alicdn.com/kf/one.jpg",
    ]);
  });

  it("reads ratings and origin", () => {
    expect(raw.ratingAverage).toBe(4.7);
    expect(raw.ratingCount).toBe(2841);
    expect(raw.shipsFrom).toBe("China");
  });

  it("resolves SKU property ids into readable variant options", () => {
    expect(raw.variants).toEqual([
      {
        id: "12001",
        options: { Color: "Black" },
        priceCents: 1899,
        available: true,
        sku: "14:350#Black",
      },
      {
        id: "12002",
        options: { Color: "White" },
        priceCents: 2150,
        available: false,
        sku: "14:351#White",
      },
    ]);
  });

  it("returns nothing for a page without page state", () => {
    expect(fromRunParams(EMPTY_HTML)).toEqual({});
  });
});

describe("fromJsonLd", () => {
  const raw = fromJsonLd(JSON_LD_HTML);

  it("reads a Product block", () => {
    expect(raw.title).toBe("Stainless Steel Water Bottle");
    expect(raw.priceCents).toBe(1450);
    expect(raw.currency).toBe("EUR");
    expect(raw.ratingAverage).toBe(4.4);
    expect(raw.ratingCount).toBe(189);
  });

  it("converts an HTML description to text", () => {
    expect(raw.description).toBe("Keeps drinks cold for 24 hours.");
  });

  it("survives a malformed sibling block", () => {
    expect(raw.images).toEqual(["https://ae01.alicdn.com/kf/bottle.jpg"]);
  });
});

describe("fromOpenGraph", () => {
  const raw = fromOpenGraph(OPEN_GRAPH_HTML);

  it("decodes entities in the title", () => {
    expect(raw.title).toBe("Folding Camp Chair & Bag");
  });

  it("reads price, currency and image", () => {
    expect(raw.priceCents).toBe(2700);
    expect(raw.currency).toBe("GBP");
    expect(raw.images).toEqual(["https://ae01.alicdn.com/kf/chair.jpg"]);
  });

  it("falls back to the title tag when og:title is missing", () => {
    expect(fromOpenGraph("<html><head><title>Bare</title></head></html>").title).toBe(
      "Bare",
    );
  });
});

describe("mergeRaw", () => {
  it("lets earlier sources win and later ones fill gaps", () => {
    const merged = mergeRaw(
      { title: "From page state" },
      { title: "From JSON-LD", priceCents: 999, images: ["https://x/a.jpg"] },
    );
    expect(merged.title).toBe("From page state");
    expect(merged.priceCents).toBe(999);
    expect(merged.images).toEqual(["https://x/a.jpg"]);
  });
});

describe("extractRawProduct", () => {
  it("prefers page state over OpenGraph on a full page", () => {
    expect(extractRawProduct(RUN_PARAMS_HTML).title).toBe("Wireless Earbuds Pro ANC");
  });

  it("still works when only OpenGraph is present", () => {
    expect(extractRawProduct(OPEN_GRAPH_HTML).priceCents).toBe(2700);
  });
});

describe("toNormalizedProduct", () => {
  it("produces a validated product", () => {
    const product = toNormalizedProduct(
      extractRawProduct(RUN_PARAMS_HTML),
      parsedUrl,
      { now },
    );

    expect(product.sourceId).toBe("1005006123456789");
    expect(product.title).toBe("Wireless Earbuds Pro ANC");
    expect(product.price).toEqual({ amountCents: 1899, currency: "USD" });
    expect(product.compareAtPrice).toEqual({ amountCents: 3999, currency: "USD" });
    expect(product.scrapedAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("de-duplicates images and uses the title as alt text", () => {
    const product = toNormalizedProduct(
      extractRawProduct(RUN_PARAMS_HTML),
      parsedUrl,
      { now },
    );
    expect(product.images).toHaveLength(2);
    expect(product.images[0]?.alt).toBe("Wireless Earbuds Pro ANC");
  });

  it("drops a compare-at price that isn't actually higher", () => {
    const product = toNormalizedProduct(
      { images: [], highlights: [], variants: [], title: "T", priceCents: 1000, compareAtPriceCents: 900 },
      parsedUrl,
      { now },
    );
    expect(product.compareAtPrice).toBeNull();
  });

  it("fails with a readable message when the title is missing", () => {
    try {
      toNormalizedProduct(
        { images: [], highlights: [], variants: [], priceCents: 100 },
        parsedUrl,
        { now },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("PARSE_FAILED");
      expect((error as AppError).message).toMatch(/couldn't read that product page/i);
    }
  });

  it("fails when no price could be found", () => {
    try {
      toNormalizedProduct(extractRawProduct(NO_PRICE_HTML), parsedUrl, { now });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("PARSE_FAILED");
      expect((error as AppError).detail).toBe("missing price");
    }
  });

  it("defaults the currency to USD when the page didn't say", () => {
    const product = toNormalizedProduct(
      { images: [], highlights: [], variants: [], title: "T", priceCents: 100 },
      parsedUrl,
      { now },
    );
    expect(product.price.currency).toBe("USD");
  });
});
