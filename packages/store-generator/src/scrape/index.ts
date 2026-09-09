import { AppError, type NormalizedProduct } from "@repo/shared";
import { detectChallenge, detectChallengeInHtml } from "./challenge.js";
import type { FetchPageOptions } from "./fetch.js";
import { extractRawProductFromPage, toNormalizedProduct } from "./normalize.js";
import { httpPageSource, type LoadedPage, type PageSource } from "./page-source.js";
import { isShortLink, parseProductUrl, type ParsedProductUrl } from "./url.js";

export * from "./url.js";
export * from "./extract.js";
export * from "./normalize.js";
export * from "./fetch.js";
export * from "./challenge.js";
export * from "./page-source.js";

export interface ScrapeOptions extends FetchPageOptions {
  now?: Date;
  /**
   * Where page contents come from. Defaults to plain HTTP, which is enough for
   * a server-rendered source but not for AliExpress — the desktop app supplies
   * a Chromium-backed source instead.
   */
  pageSource?: PageSource;
}

/**
 * Takes a pasted product URL and returns normalized product data.
 *
 * Three separable steps — resolve URL, load page, extract + normalize — so a
 * change in AliExpress's markup only ever breaks the middle one, and the site
 * generator downstream never sees a page at all.
 */
export async function scrapeProduct(
  rawUrl: string,
  options: ScrapeOptions = {},
): Promise<NormalizedProduct> {
  const source = options.pageSource ?? httpPageSource(options);
  const nowOption = options.now === undefined ? {} : { now: options.now };

  // A short link only reveals its item id by being followed, so we load it
  // first and reuse that same page rather than fetching twice.
  if (isShortLink(rawUrl)) {
    const page = await source.load(rawUrl.trim());
    let parsed: ParsedProductUrl;
    try {
      parsed = parseProductUrl(page.finalUrl);
    } catch {
      throw new AppError(
        "PRODUCT_NOT_FOUND",
        "That short link didn't lead to a product page. Open it in your browser and copy the full product URL.",
      );
    }
    return normalizePage(page, parsed, nowOption);
  }

  const parsed = parseProductUrl(rawUrl);
  const page = await source.load(parsed.cleanedUrl);
  return normalizePage(page, parsed, nowOption);
}

/**
 * Turns a loaded page into a product, or explains why it couldn't.
 *
 * An unresolved challenge is the difference between "AliExpress changed its
 * markup" and "AliExpress is asking you to prove you're human" — reporting the
 * first when it's really the second sends people hunting for the wrong bug.
 */
function normalizePage(
  page: LoadedPage,
  parsed: ParsedProductUrl,
  nowOption: { now?: Date },
): NormalizedProduct {
  const raw = extractRawProductFromPage(page);

  if (!raw.title) {
    const challenge =
      detectChallenge(page.finalUrl) ?? detectChallengeInHtml(page.html);
    if (challenge) {
      throw new AppError(
        "BOT_CHALLENGE",
        "AliExpress blocked this listing before it loaded. Open it in the built-in browser, clear the check, and try again.",
        challenge,
      );
    }
  }

  return toNormalizedProduct(raw, parsed, nowOption);
}

/**
 * Resolves the pasted URL to a canonical item URL, following the redirect hop
 * that `a.aliexpress.com` short links need.
 */
export async function resolveProductUrl(
  rawUrl: string,
  options: ScrapeOptions = {},
): Promise<ParsedProductUrl> {
  if (!isShortLink(rawUrl)) return parseProductUrl(rawUrl);

  const source = options.pageSource ?? httpPageSource(options);
  const page = await source.load(rawUrl.trim());
  try {
    return parseProductUrl(page.finalUrl);
  } catch {
    throw new AppError(
      "PRODUCT_NOT_FOUND",
      "That short link didn't lead to a product page. Open it in your browser and copy the full product URL.",
    );
  }
}
