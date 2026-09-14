import { AppError } from "@repo/shared";
import { describe, expect, it, vi } from "vitest";
import {
  decodeHtmlEntities,
  detectCurrency,
  extractJsonAfter,
  htmlToText,
  normalizeImageUrl,
  parsePriceToCents,
} from "./extract.js";
import { fetchPage, type FetchLike } from "./fetch.js";
import {
  extractRawProduct,
  fromJsonLd,
  fromOpenGraph,
  fromRunParams,
  mergeRaw,
  toNormalizedProduct,
} from "./normalize.js";
import { scrapeProduct } from "./index.js";
import { isShortLink, parseProductUrl } from "./url.js";

describe("parseProductUrl", () => {
  it("accepts a standard item URL", () => {
    const parsed = parseProductUrl(
      "https://www.aliexpress.com/item/1005006123456789.html",
    );
    expect(parsed.itemId).toBe("1005006123456789");
    expect(parsed.canonicalUrl).toBe(
      "https://www.aliexpress.com/item/1005006123456789.html",
    );
  });

  it("accepts country domains", () => {
    expect(
      parseProductUrl("https://www.aliexpress.us/item/1005006123456789.html")
        .itemId,
    ).toBe("1005006123456789");
  });

  it("strips tracking parameters but keeps the rest", () => {
    const parsed = parseProductUrl(
      "https://www.aliexpress.com/item/1005006.html?spm=a2g0o.detail&algo_pvid=xyz&currency=USD",
    );
    expect(parsed.cleanedUrl).not.toContain("spm");
    expect(parsed.cleanedUrl).not.toContain("algo_pvid");
    expect(parsed.cleanedUrl).toContain("currency=USD");
  });

  it("adds a scheme when the user pasted a bare domain", () => {
    expect(
      parseProductUrl("www.aliexpress.com/item/1005006.html").itemId,
    ).toBe("1005006");
  });

  it("rejects an empty string with a usable message", () => {
    expect(() => parseProductUrl("  ")).toThrowError(
      /Paste an AliExpress product link/,
    );
  });

  it("rejects a non-AliExpress host", () => {
    try {
      parseProductUrl("https://www.amazon.com/dp/B01/item/1005006.html");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("UNSUPPORTED_SOURCE");
    }
  });

  it("rejects an AliExpress URL that isn't a product page", () => {
    try {
      parseProductUrl("https://www.aliexpress.com/category/123/phones.html");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("INVALID_URL");
    }
  });

  it("recognises short links", () => {
    expect(isShortLink("https://a.aliexpress.com/_mAbCdEf")).toBe(true);
    expect(isShortLink("https://www.aliexpress.com/item/1.html")).toBe(false);
  });
});

describe("parsePriceToCents", () => {
  it.each([
    ["US $12.34", 1234],
    ["$1,234.56", 123456],
    ["12,34 EUR", 1234],
    ["1.234,56", 123456],
    ["£9.99", 999],
    ["19", 1900],
  ])("parses %s", (input, expected) => {
    expect(parsePriceToCents(input)).toBe(expected);
  });

  it("takes the lower bound of a range", () => {
    expect(parsePriceToCents("$10.00 - $20.00")).toBe(1000);
  });

  it("returns undefined when there is no number", () => {
    expect(parsePriceToCents("Free shipping")).toBeUndefined();
  });
});

describe("detectCurrency", () => {
  it("prefers an explicit ISO code", () => {
    expect(detectCurrency("12.00 USD")).toBe("USD");
  });

  it("falls back to a symbol", () => {
    expect(detectCurrency("€12,00")).toBe("EUR");
  });

  it("returns undefined when it cannot tell", () => {
    expect(detectCurrency("12.00")).toBeUndefined();
  });
});

describe("normalizeImageUrl", () => {
  it("upgrades protocol-relative URLs", () => {
    expect(normalizeImageUrl("//ae01.alicdn.com/kf/a.jpg")).toBe(
      "https://ae01.alicdn.com/kf/a.jpg",
    );
  });

  it("drops the CDN resize suffix", () => {
    expect(normalizeImageUrl("https://ae01.alicdn.com/kf/a.jpg_640x640q90.jpg")).toBe(
      "https://ae01.alicdn.com/kf/a.jpg",
    );
  });

  it("rejects non-http values", () => {
    expect(normalizeImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(normalizeImageUrl("   ")).toBeNull();
  });
});

describe("extractJsonAfter", () => {
  it("extracts a balanced object", () => {
    const html = 'window.runParams = {"a":1,"b":{"c":2}};</script>';
    expect(extractJsonAfter(html, "window.runParams")).toEqual({
      a: 1,
      b: { c: 2 },
    });
  });

  it("is not fooled by braces inside strings", () => {
    const html = 'window.runParams = {"a":"}{","b":2};';
    expect(extractJsonAfter(html, "window.runParams")).toEqual({
      a: "}{",
      b: 2,
    });
  });

  it("handles escaped quotes inside strings", () => {
    const html = 'window.runParams = {"a":"say \\"hi\\" }","b":1};';
    expect(extractJsonAfter(html, "window.runParams")).toEqual({
      a: 'say "hi" }',
      b: 1,
    });
  });

  it("returns null when the marker is absent", () => {
    expect(extractJsonAfter("<html></html>", "window.runParams")).toBeNull();
  });

  it("returns null for unbalanced or invalid JSON", () => {
    expect(extractJsonAfter("window.runParams = {oops", "window.runParams")).toBeNull();
  });
});

describe("decodeHtmlEntities / htmlToText", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &#39;s &#x2605;")).toBe(
      "Tom & Jerry 's ★",
    );
  });

  it("strips tags and scripts", () => {
    expect(htmlToText("<div>Hello<script>evil()</script> <b>world</b></div>")).toBe(
      "Hello world",
    );
  });
});
