import { describe, expect, it } from "vitest";
import { scrapeProduct, type PageSource } from "./index.js";
import { extractRawProductFromPage, productDataFromPageState } from "./normalize.js";

/**
 * The object shape a live AliExpress page exposes as `window.runParams.data`.
 * This is the path that actually runs in the app — the served HTML has none of
 * this in it.
 */
const PAGE_DATA = {
  titleComponent: { subject: "Wireless Earbuds Pro ANC" },
  imageComponent: { imagePathList: ["//ae01.alicdn.com/kf/one.jpg_640x640.jpg"] },
  priceComponent: {
    discountPrice: { minActivityAmount: { value: 18.99, currency: "USD" } },
    origPrice: { minAmount: { value: 39.99, currency: "USD" } },
  },
  feedbackComponent: { evarageStar: 4.7, totalValidNum: 2841 },
};

/** A page shell with no product data in it, as AliExpress really serves. */
const EMPTY_SHELL = "<html><head><title></title></head><body></body></html>";

describe("productDataFromPageState", () => {
  it("reads a product out of live page state", () => {
    const raw = productDataFromPageState({ data: PAGE_DATA });
    expect(raw.title).toBe("Wireless Earbuds Pro ANC");
    expect(raw.priceCents).toBe(1899);
    expect(raw.compareAtPriceCents).toBe(3999);
    expect(raw.ratingAverage).toBe(4.7);
  });

  it("accepts state that is already unwrapped", () => {
    expect(productDataFromPageState(PAGE_DATA).title).toBe(
      "Wireless Earbuds Pro ANC",
    );
  });

  it("ignores junk", () => {
    expect(productDataFromPageState(null)).toEqual({});
    expect(productDataFromPageState("nope")).toEqual({});
  });
});

describe("extractRawProductFromPage", () => {
  it("prefers live page state over an empty HTML shell", () => {
    const raw = extractRawProductFromPage({
      html: EMPTY_SHELL,
      pageData: { data: PAGE_DATA },
    });
    expect(raw.title).toBe("Wireless Earbuds Pro ANC");
    expect(raw.priceCents).toBe(1899);
  });

  it("still reads server-rendered HTML when there is no page state", () => {
    const raw = extractRawProductFromPage({
      html: '<html><head><meta property="og:title" content="From OG" /><meta property="product:price:amount" content="9.99" /></head></html>',
    });
    expect(raw.title).toBe("From OG");
    expect(raw.priceCents).toBe(999);
  });
});

describe("scrapeProduct with a browser-style page source", () => {
  const source = (page: {
    html: string;
    finalUrl: string;
    pageData?: unknown;
  }): PageSource => ({ name: "fake", load: async () => page });

  it("builds a product from page state that the HTML lacks entirely", async () => {
    const product = await scrapeProduct(
      "https://www.aliexpress.com/item/1005006123456789.html",
      {
        now: new Date("2026-09-04T12:00:00.000Z"),
        pageSource: source({
          html: EMPTY_SHELL,
          finalUrl: "https://www.aliexpress.us/item/3256805937142037.html",
          pageData: { data: PAGE_DATA },
        }),
      },
    );

    expect(product.title).toBe("Wireless Earbuds Pro ANC");
    expect(product.price).toEqual({ amountCents: 1899, currency: "USD" });
    // sourceId comes from the pasted URL, not the regional gateway's rewrite.
    expect(product.sourceId).toBe("1005006123456789");
  });

  it("reports a bot wall as a challenge, not as changed markup", async () => {
    await expect(
      scrapeProduct("https://www.aliexpress.com/item/1005006123456789.html", {
        pageSource: source({
          html: "<html>x5secdata</html>",
          finalUrl:
            "https://www.aliexpress.com//item/1.html/_____tmd_____/punish?x5secdata=abc",
        }),
      }),
    ).rejects.toMatchObject({ code: "BOT_CHALLENGE" });
  });

  it("still reports genuinely changed markup as a parse failure", async () => {
    await expect(
      scrapeProduct("https://www.aliexpress.com/item/1005006123456789.html", {
        pageSource: source({
          html: "<html><body>a real page with no product</body></html>",
          finalUrl: "https://www.aliexpress.us/item/2.html",
        }),
      }),
    ).rejects.toMatchObject({ code: "PARSE_FAILED" });
  });

  it("resolves a short link through the page source it already loaded", async () => {
    const product = await scrapeProduct("https://a.aliexpress.com/_mAbCdEf", {
      now: new Date("2026-09-04T12:00:00.000Z"),
      pageSource: source({
        html: EMPTY_SHELL,
        finalUrl: "https://www.aliexpress.com/item/1005006999999999.html",
        pageData: { data: PAGE_DATA },
      }),
    });
    expect(product.sourceId).toBe("1005006999999999");
  });
});
