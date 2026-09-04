import { AppError, type NormalizedProduct } from "@repo/shared";
import { fetchPage, type FetchPageOptions } from "./fetch.js";
import { extractRawProduct, toNormalizedProduct } from "./normalize.js";
import { isShortLink, parseProductUrl, type ParsedProductUrl } from "./url.js";

export * from "./url.js";
export * from "./extract.js";
export * from "./normalize.js";
export * from "./fetch.js";

export interface ScrapeOptions extends FetchPageOptions {
  now?: Date;
}

/**
 * Pastes-in a product URL and returns normalized product data.
 *
 * The pipeline is deliberately three separable steps — resolve URL, fetch HTML,
 * extract + normalize — so a change in AliExpress's markup only ever breaks the
 * middle one, and the site generator downstream never sees raw HTML at all.
 */
export async function scrapeProduct(
  rawUrl: string,
  options: ScrapeOptions = {},
): Promise<NormalizedProduct> {
  const parsed = await resolveProductUrl(rawUrl, options);
  const page = await fetchPage(parsed.cleanedUrl, options);
  const raw = extractRawProduct(page.html);

  const nowOption = options.now === undefined ? {} : { now: options.now };
  return toNormalizedProduct(raw, parsed, nowOption);
}

/**
 * Resolves the pasted URL to a canonical item URL, following the one redirect
 * hop that `a.aliexpress.com` short links need.
 */
export async function resolveProductUrl(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<ParsedProductUrl> {
  if (!isShortLink(rawUrl)) return parseProductUrl(rawUrl);

  const page = await fetchPage(rawUrl.trim(), options);
  try {
    return parseProductUrl(page.finalUrl);
  } catch {
    throw new AppError(
      "PRODUCT_NOT_FOUND",
      "That short link didn't lead to a product page. Open it in your browser and copy the full product URL.",
    );
  }
}
