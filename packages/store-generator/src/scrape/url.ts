import { AppError } from "@repo/shared";

/**
 * AliExpress hosts the same catalogue on a long tail of country domains. We
 * accept any of them plus the `a.aliexpress.com` short-link host, and reject
 * everything else loudly rather than half-scraping an unrelated page.
 */
const ALIEXPRESS_HOST = /(^|\.)aliexpress\.(com|us|ru|es|fr|it|nl|pl|co\.kr|co\.jp)$/i;

/** `/item/1005006123456789.html`, with or without locale prefixes. */
const ITEM_PATH = /\/item\/(\d{6,})\.html/i;

/** Short links (`a.aliexpress.com/_mABCdef`) resolve to an item via redirect. */
const SHORT_LINK_HOST = /^a\.aliexpress\.com$/i;

export interface ParsedProductUrl {
  /** The numeric AliExpress item id. */
  itemId: string;
  /** Canonical `https://www.aliexpress.com/item/<id>.html` form. */
  canonicalUrl: string;
  /** The URL as supplied, minus tracking parameters. */
  cleanedUrl: string;
}

export function isShortLink(rawUrl: string): boolean {
  try {
    return SHORT_LINK_HOST.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** Query params AliExpress uses purely for attribution; never worth keeping. */
const TRACKING_PARAMS = [
  "spm",
  "aff_fcid",
  "aff_fsk",
  "aff_platform",
  "aff_trace_key",
  "afSmartRedirect",
  "algo_pvid",
  "algo_exp_id",
  "btsid",
  "ws_ab_test",
  "gatewayAdapt",
  "sk",
  "terminal_id",
  "pdp_npi",
];

/**
 * Validates and canonicalises a pasted product link.
 *
 * Throws {@link AppError} with `INVALID_URL` / `UNSUPPORTED_SOURCE` so the UI
 * can tell the user precisely what was wrong with what they pasted.
 */
export function parseProductUrl(rawUrl: string): ParsedProductUrl {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new AppError("INVALID_URL", "Paste an AliExpress product link first.");
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new AppError(
      "INVALID_URL",
      "That doesn't look like a link. Copy the product URL from your browser's address bar.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("INVALID_URL", "Product links must start with https://");
  }

  if (!ALIEXPRESS_HOST.test(url.hostname)) {
    throw new AppError(
      "UNSUPPORTED_SOURCE",
      "Only AliExpress product links are supported right now.",
      url.hostname,
    );
  }

  const match = ITEM_PATH.exec(url.pathname);
  if (!match?.[1]) {
    throw new AppError(
      "INVALID_URL",
      "That AliExpress link doesn't point at a single product. Open the product page and copy the link from there.",
    );
  }

  const itemId = match[1];
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);

  return {
    itemId,
    canonicalUrl: `https://www.aliexpress.com/item/${itemId}.html`,
    cleanedUrl: url.toString(),
  };
}
