import { AppError, NormalizedProductSchema, type NormalizedProduct } from "@repo/shared";
import {
  detectCurrency,
  emptyRawProduct,
  extractJsonAfter,
  extractJsonLd,
  extractMeta,
  extractTitleTag,
  htmlToText,
  normalizeImageUrl,
  parsePriceToCents,
  type RawProductData,
  type RawVariant,
} from "./extract.js";
import type { ParsedProductUrl } from "./url.js";

/** Safe nested read: `get(obj, "a", "b", 0)`. Returns undefined on any miss. */
function get(source: unknown, ...path: (string | number)[]): unknown {
  let current = source;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number.parseFloat(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Reads AliExpress's inlined page state (`window.runParams`).
 *
 * Two generations of key names are in the wild — the newer `*Component` set and
 * the older `*Module` set — so every lookup tries both and tolerates neither
 * being present.
 */
export function fromRunParams(html: string): Partial<RawProductData> {
  const root =
    extractJsonAfter(html, "window.runParams") ??
    extractJsonAfter(html, "window._dida_config_");
  if (!root) return {};

  return productDataFromPageState(root);
}

/**
 * Reads AliExpress page state that has already been parsed.
 *
 * A live browser page hands us the real `window.runParams` object, so the same
 * field mapping has to work without going through HTML text first.
 */
export function productDataFromPageState(root: unknown): Partial<RawProductData> {
  if (root === null || typeof root !== "object") return {};

  const data = (get(root, "data") ?? root) as unknown;
  const out: Partial<RawProductData> = {};

  const title =
    asString(get(data, "titleComponent", "subject")) ??
    asString(get(data, "titleModule", "subject")) ??
    asString(get(data, "productInfoComponent", "subject"));
  if (title) out.title = title;

  const images = asArray(
    get(data, "imageComponent", "imagePathList") ??
      get(data, "imageModule", "imagePathList"),
  )
    .map((entry) => (typeof entry === "string" ? normalizeImageUrl(entry) : null))
    .filter((url): url is string => url !== null);
  if (images.length) out.images = images;

  const priceCents = readComponentPrice(data, [
    ["priceComponent", "discountPrice", "minActivityAmount", "value"],
    ["priceComponent", "origPrice", "minAmount", "value"],
    ["priceModule", "formatedActivityPrice"],
    ["priceModule", "minActivityAmount", "value"],
    ["priceModule", "formatedPrice"],
  ]);
  if (priceCents !== undefined) out.priceCents = priceCents;

  const compareAt = readComponentPrice(data, [
    ["priceComponent", "origPrice", "minAmount", "value"],
    ["priceModule", "minAmount", "value"],
    ["priceModule", "formatedPrice"],
  ]);
  if (compareAt !== undefined && compareAt !== priceCents) {
    out.compareAtPriceCents = compareAt;
  }

  const currency =
    asString(get(data, "priceComponent", "discountPrice", "minActivityAmount", "currency")) ??
    asString(get(data, "priceModule", "minActivityAmount", "currency")) ??
    asString(get(data, "currencyCode"));
  if (currency) out.currency = currency.toUpperCase();

  const rating = asNumber(
    get(data, "feedbackComponent", "evarageStar") ??
      get(data, "titleModule", "feedbackRating", "averageStar"),
  );
  if (rating !== undefined) out.ratingAverage = clamp(rating, 0, 5);

  const ratingCount = asNumber(
    get(data, "feedbackComponent", "totalValidNum") ??
      get(data, "titleModule", "feedbackRating", "totalValidNum"),
  );
  if (ratingCount !== undefined && ratingCount >= 0) {
    out.ratingCount = Math.round(ratingCount);
  }

  const shipsFrom =
    asString(get(data, "shippingComponent", "shipFromCountryFullName")) ??
    asString(get(data, "shippingModule", "generalFreightInfo", "originalLayoutResultList", 0, "bizData", "shipFrom"));
  if (shipsFrom) out.shipsFrom = shipsFrom;

  const variants = readVariants(data, out.currency);
  if (variants.length) out.variants = variants;

  return out;
}

function readComponentPrice(
  data: unknown,
  paths: (string | number)[][],
): number | undefined {
  for (const path of paths) {
    const raw = get(data, ...path);
    const numeric = asNumber(raw);
    if (numeric !== undefined) return Math.round(numeric * 100);

    const text = asString(raw);
    if (text) {
      const parsed = parsePriceToCents(text);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function readVariants(data: unknown, currency: string | undefined): RawVariant[] {
  const skuList = asArray(
    get(data, "skuComponent", "productSKUPropertyList") ??
      get(data, "skuModule", "productSKUPropertyList"),
  );
  const priceList = asArray(
    get(data, "priceComponent", "skuPriceList") ??
      get(data, "skuModule", "skuPriceList"),
  );

  // Property id -> { name, values } so a SKU's `propPath` can be made readable.
  const propertyNames = new Map<string, string>();
  const valueNames = new Map<string, string>();

  for (const property of skuList) {
    const propId = asNumber(get(property, "skuPropertyId"));
    const propName = asString(get(property, "skuPropertyName"));
    if (propId === undefined || !propName) continue;
    propertyNames.set(String(propId), propName);

    for (const value of asArray(get(property, "skuPropertyValues"))) {
      const valueId = asNumber(get(value, "propertyValueId"));
      const display =
        asString(get(value, "propertyValueDisplayName")) ??
        asString(get(value, "propertyValueName"));
      if (valueId !== undefined && display) {
        valueNames.set(`${propId}:${valueId}`, display);
      }
    }
  }

  const variants: RawVariant[] = [];
  for (const sku of priceList) {
    const id =
      asString(get(sku, "skuId")) ??
      asString(get(sku, "skuIdStr")) ??
      asNumber(get(sku, "skuId"))?.toString();
    if (!id) continue;

    const amount =
      asNumber(get(sku, "skuVal", "skuActivityAmount", "value")) ??
      asNumber(get(sku, "skuVal", "skuAmount", "value"));
    const priceCents =
      amount !== undefined
        ? Math.round(amount * 100)
        : parsePriceToCents(asString(get(sku, "skuVal", "skuCalPrice")) ?? "");
    if (priceCents === undefined) continue;

    const options: Record<string, string> = {};
    const propPath = asString(get(sku, "skuPropIds")) ?? asString(get(sku, "propPath"));
    if (propPath) {
      for (const pair of propPath.split(",")) {
        const [propId, valueId] = pair.includes(":")
          ? pair.split(":")
          : [undefined, pair];
        const resolvedProp = propId ? propertyNames.get(propId) : undefined;
        const resolvedValue =
          propId && valueId ? valueNames.get(`${propId}:${valueId}`) : undefined;
        if (resolvedProp && resolvedValue) options[resolvedProp] = resolvedValue;
      }
    }

    const availableQuantity = asNumber(get(sku, "skuVal", "availQuantity"));
    const variant: RawVariant = {
      id,
      options,
      priceCents,
      available: availableQuantity === undefined ? true : availableQuantity > 0,
    };
    const sku_ = asString(get(sku, "skuAttr"));
    if (sku_) variant.sku = sku_;
    variants.push(variant);
  }

  void currency;
  return variants;
}

/** Schema.org `Product` blocks, which AliExpress emits for search engines. */
export function fromJsonLd(html: string): Partial<RawProductData> {
  const out: Partial<RawProductData> = {};

  for (const block of extractJsonLd(html)) {
    const candidates = Array.isArray(block) ? block : [block];
    for (const node of candidates) {
      const type = get(node, "@type");
      const types = Array.isArray(type) ? type : [type];
      if (!types.includes("Product")) continue;

      const title = asString(get(node, "name"));
      if (title && !out.title) out.title = title;

      const description = asString(get(node, "description"));
      if (description && !out.description) out.description = htmlToText(description);

      const image = get(node, "image");
      const images = (Array.isArray(image) ? image : [image])
        .map((entry) => (typeof entry === "string" ? normalizeImageUrl(entry) : null))
        .filter((url): url is string => url !== null);
      if (images.length && !out.images?.length) out.images = images;

      const offer = Array.isArray(get(node, "offers"))
        ? get(node, "offers", 0)
        : get(node, "offers");
      const price = asNumber(get(offer, "price")) ?? asNumber(get(offer, "lowPrice"));
      if (price !== undefined && out.priceCents === undefined) {
        out.priceCents = Math.round(price * 100);
      }
      const currency = asString(get(offer, "priceCurrency"));
      if (currency && !out.currency) out.currency = currency.toUpperCase();

      const rating = asNumber(get(node, "aggregateRating", "ratingValue"));
      if (rating !== undefined && out.ratingAverage === undefined) {
        out.ratingAverage = clamp(rating, 0, 5);
      }
      const reviewCount = asNumber(get(node, "aggregateRating", "reviewCount"));
      if (reviewCount !== undefined && out.ratingCount === undefined) {
        out.ratingCount = Math.round(reviewCount);
      }
    }
  }

  return out;
}

/** Last resort: OpenGraph tags, which almost every page still carries. */
export function fromOpenGraph(html: string): Partial<RawProductData> {
  const out: Partial<RawProductData> = {};

  const title = extractMeta(html, "og:title") ?? extractTitleTag(html);
  if (title) out.title = title;

  const description =
    extractMeta(html, "og:description") ?? extractMeta(html, "description");
  if (description) out.description = description;

  const image = extractMeta(html, "og:image");
  const normalized = image ? normalizeImageUrl(image) : null;
  if (normalized) out.images = [normalized];

  const amount =
    extractMeta(html, "product:price:amount") ??
    extractMeta(html, "og:price:amount");
  if (amount) {
    const cents = parsePriceToCents(amount);
    if (cents !== undefined) out.priceCents = cents;
  }

  const currency =
    extractMeta(html, "product:price:currency") ??
    extractMeta(html, "og:price:currency") ??
    (amount ? detectCurrency(amount) : undefined);
  if (currency) out.currency = currency.toUpperCase();

  return out;
}

/** Earlier sources win; later ones only fill gaps. */
export function mergeRaw(...sources: Partial<RawProductData>[]): RawProductData {
  const merged = emptyRawProduct();

  for (const source of sources) {
    if (!merged.title && source.title) merged.title = source.title;
    if (!merged.description && source.description) {
      merged.description = source.description;
    }
    if (!merged.images.length && source.images?.length) {
      merged.images = source.images;
    }
    if (merged.priceCents === undefined && source.priceCents !== undefined) {
      merged.priceCents = source.priceCents;
    }
    if (
      merged.compareAtPriceCents === undefined &&
      source.compareAtPriceCents !== undefined
    ) {
      merged.compareAtPriceCents = source.compareAtPriceCents;
    }
    if (!merged.currency && source.currency) merged.currency = source.currency;
    if (merged.ratingAverage === undefined && source.ratingAverage !== undefined) {
      merged.ratingAverage = source.ratingAverage;
    }
    if (merged.ratingCount === undefined && source.ratingCount !== undefined) {
      merged.ratingCount = source.ratingCount;
    }
    if (!merged.shipsFrom && source.shipsFrom) merged.shipsFrom = source.shipsFrom;
    if (!merged.highlights.length && source.highlights?.length) {
      merged.highlights = source.highlights;
    }
    if (!merged.variants.length && source.variants?.length) {
      merged.variants = source.variants;
    }
  }

  return merged;
}

/** Runs every extractor over the page, best source first. */
export function extractRawProduct(html: string): RawProductData {
  return mergeRaw(fromRunParams(html), fromJsonLd(html), fromOpenGraph(html));
}

/**
 * Turns text read off the rendered page into loose product data.
 *
 * Only used when the structured page state wasn't available. Deliberately
 * forgiving: a missing field here just means a later source gets a turn.
 */
export function fromDomProduct(dom: {
  title?: string | null;
  priceText?: string | null;
  compareAtText?: string | null;
  images?: string[];
  ratingText?: string | null;
  ratingCountText?: string | null;
  shipsFrom?: string | null;
  description?: string | null;
}): Partial<RawProductData> {
  const out: Partial<RawProductData> = {};

  const title = asString(dom.title);
  if (title) out.title = title;

  const description = asString(dom.description);
  if (description) out.description = description;

  if (dom.priceText) {
    const cents = parsePriceToCents(dom.priceText);
    if (cents !== undefined) out.priceCents = cents;
    const currency = detectCurrency(dom.priceText);
    if (currency) out.currency = currency;
  }

  if (dom.compareAtText) {
    const cents = parsePriceToCents(dom.compareAtText);
    if (cents !== undefined) out.compareAtPriceCents = cents;
  }

  const images = (dom.images ?? [])
    .map((url) => normalizeImageUrl(url))
    .filter((url): url is string => url !== null);
  if (images.length) out.images = images;

  if (dom.ratingText) {
    const rating = asNumber(/[\d.]+/.exec(dom.ratingText)?.[0]);
    if (rating !== undefined) out.ratingAverage = clamp(rating, 0, 5);
  }

  if (dom.ratingCountText) {
    const count = asNumber(dom.ratingCountText.replace(/[^\d]/g, ""));
    if (count !== undefined && count >= 0) out.ratingCount = Math.round(count);
  }

  const shipsFrom = asString(dom.shipsFrom);
  if (shipsFrom) out.shipsFrom = shipsFrom;

  return out;
}

/**
 * Extracts from a loaded page, preferring page state read out of a live
 * browser.
 *
 * AliExpress renders product data client-side, so the served HTML has an empty
 * title and no price. When the page came from a real Chromium window we get the
 * populated `runParams` object instead, and that is by far the best source. The
 * HTML extractors stay in the chain as a fallback for anything server-rendered.
 *
 * Typed structurally so this file stays independent of the page-source module.
 */
export function extractRawProductFromPage(page: {
  html: string;
  pageData?: unknown;
  domProduct?: Parameters<typeof fromDomProduct>[0];
}): RawProductData {
  return mergeRaw(
    page.pageData === undefined ? {} : productDataFromPageState(page.pageData),
    page.domProduct === undefined ? {} : fromDomProduct(page.domProduct),
    fromRunParams(page.html),
    fromJsonLd(page.html),
    fromOpenGraph(page.html),
  );
}

export interface NormalizeOptions {
  now?: Date;
}

/**
 * Turns loose scraped data into a validated {@link NormalizedProduct}.
 *
 * A store is only worth generating if we got at least a title and a price, so
 * anything less fails here with a message the user can act on.
 */
export function toNormalizedProduct(
  raw: RawProductData,
  parsed: ParsedProductUrl,
  { now = new Date() }: NormalizeOptions = {},
): NormalizedProduct {
  if (!raw.title) {
    throw new AppError(
      "PARSE_FAILED",
      "We couldn't read that product page. AliExpress may have changed its layout, or the listing may be region-locked.",
      "missing title",
    );
  }

  if (raw.priceCents === undefined) {
    throw new AppError(
      "PARSE_FAILED",
      "We read the product but couldn't find a price on that page. Try opening the link in your browser to check the listing is still live.",
      "missing price",
    );
  }

  const currency = raw.currency ?? "USD";
  const images = dedupe(raw.images).map((url) => ({ url, alt: raw.title! }));

  return NormalizedProductSchema.parse({
    sourceId: parsed.itemId,
    sourceUrl: parsed.canonicalUrl,
    title: raw.title,
    description: raw.description ?? "",
    highlights: raw.highlights,
    price: { amountCents: raw.priceCents, currency },
    compareAtPrice:
      raw.compareAtPriceCents !== undefined &&
      raw.compareAtPriceCents > raw.priceCents
        ? { amountCents: raw.compareAtPriceCents, currency }
        : null,
    images,
    variants: raw.variants,
    ratingAverage: raw.ratingAverage ?? null,
    ratingCount: raw.ratingCount ?? null,
    shipsFrom: raw.shipsFrom ?? null,
    scrapedAt: now.toISOString(),
  });
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const dedupe = (values: string[]): string[] => [...new Set(values)];
