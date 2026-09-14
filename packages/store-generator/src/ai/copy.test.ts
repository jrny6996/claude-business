import type { NormalizedProduct } from "@repo/shared";
import { describe, expect, it } from "vitest";
import type { AiClient } from "./client.js";
import { generateImageAltText, withGeneratedAltText } from "./copy.js";

const product: NormalizedProduct = {
  sourceId: "1",
  sourceUrl: "https://www.aliexpress.com/item/1.html",
  title: "Wireless Earbuds",
  description: "Original.",
  highlights: [],
  price: { amountCents: 1000, currency: "USD" },
  compareAtPrice: null,
  images: [
    { url: "https://cdn.example/1.jpg", alt: "Wireless Earbuds" },
    { url: "https://cdn.example/2.jpg", alt: "Wireless Earbuds" },
  ],
  variants: [],
  ratingAverage: null,
  ratingCount: null,
  shipsFrom: null,
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

/** A provider stub — the copy layer must work against any of them. */
const stub = (reply: string): AiClient => ({
  provider: "gemini",
  model: "test",
  complete: async () => reply,
  validateKey: async () => true,
});

describe("generateImageAltText", () => {
  it("returns one entry per image", async () => {
    const alt = await generateImageAltText(
      product,
      stub('{"alt":["Earbuds in case","Earbuds worn"]}'),
    );
    expect(alt).toEqual(["Earbuds in case", "Earbuds worn"]);
  });

  it("pads from the title when the model returns too few", async () => {
    const alt = await generateImageAltText(product, stub('{"alt":["Only one"]}'));
    expect(alt).toEqual(["Only one", "Wireless Earbuds"]);
  });

  it("never calls the model for a product with no images", async () => {
    let called = false;
    const client: AiClient = {
      ...stub("{}"),
      complete: async () => {
        called = true;
        return "{}";
      },
    };

    await expect(
      generateImageAltText({ ...product, images: [] }, client),
    ).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("falls back to the title rather than throwing on junk", async () => {
    await expect(
      generateImageAltText(product, stub("the model was chatty today")),
    ).resolves.toEqual(["Wireless Earbuds", "Wireless Earbuds"]);
  });
});

describe("withGeneratedAltText", () => {
  it("replaces alt text without dropping or reordering images", () => {
    const updated = withGeneratedAltText(product, ["First", "Second"]);
    expect(updated.images).toEqual([
      { url: "https://cdn.example/1.jpg", alt: "First" },
      { url: "https://cdn.example/2.jpg", alt: "Second" },
    ]);
  });

  it("keeps the existing alt where the model gave nothing usable", () => {
    const updated = withGeneratedAltText(product, ["First", "   "]);
    expect(updated.images[1]?.alt).toBe("Wireless Earbuds");
  });

  it("is a no-op for an empty list", () => {
    expect(withGeneratedAltText(product, [])).toBe(product);
  });
});
