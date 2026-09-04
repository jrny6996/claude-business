/**
 * HTML extraction helpers.
 *
 * This is the *only* file allowed to know what an AliExpress page looks like.
 * Everything here returns loose, optional data; `normalize.ts` decides whether
 * what came back is enough to build a store from. When AliExpress changes its
 * markup, the blast radius is this file.
 */

/** Loose shape of the data we try to lift off a product page. */
export interface RawProductData {
  title?: string;
  description?: string;
  images: string[];
  /** Price in the smallest currency unit. */
  priceCents?: number;
  compareAtPriceCents?: number;
  currency?: string;
  ratingAverage?: number;
  ratingCount?: number;
  shipsFrom?: string;
  highlights: string[];
  variants: RawVariant[];
}

export interface RawVariant {
  id: string;
  options: Record<string, string>;
  priceCents: number;
  available: boolean;
  sku?: string;
}

export function emptyRawProduct(): RawProductData {
  return { images: [], highlights: [], variants: [] };
}

/**
 * Extracts the first balanced JSON object following `marker` in `html`.
 *
 * AliExpress inlines its page state as `window.runParams = {...};` inside a
 * script tag, so a regex to the closing brace is not enough — we have to match
 * braces while skipping over string literals.
 */
export function extractJsonAfter(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = html.indexOf("{", markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = "";

  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

const SCRIPT_LD_JSON =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every parseable JSON-LD block on the page. */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_LD_JSON)) {
    const body = match[1];
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body.trim()));
    } catch {
      // A single malformed block shouldn't discard the others.
    }
  }
  return blocks;
}

/** Reads `<meta property="og:title" content="...">`-style tags. */
export function extractMeta(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
    "i",
  );
  const tag = pattern.exec(html)?.[0];
  if (!tag) return undefined;

  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decodeHtmlEntities(content) : undefined;
}

export function extractTitleTag(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return raw ? decodeHtmlEntities(raw.trim()) : undefined;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    const known = ENTITIES[entity];
    if (known !== undefined) return known;

    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Strips tags and collapses whitespace, for descriptions lifted from HTML. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/**
 * Parses a displayed price into cents.
 *
 * Handles `US $12.34`, `12,34 €`, `$1,234.56` and ranges like `$10.00 - $20.00`
 * (taking the lower bound, which is what the storefront quotes as "from").
 */
export function parsePriceToCents(input: string): number | undefined {
  const firstSegment = input.split(/\s[-–]\s/)[0] ?? input;
  const digits = /[\d.,]+/.exec(firstSegment)?.[0];
  if (!digits) return undefined;

  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = digits;
  } else if (lastComma > lastDot) {
    // Comma is the decimal separator: 1.234,56
    normalized = digits.replace(/\./g, "").replace(",", ".");
  } else {
    // Dot is the decimal separator: 1,234.56
    normalized = digits.replace(/,/g, "");
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value < 0) return undefined;

  return Math.round(value * 100);
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₽": "RUB",
  "₩": "KRW",
  "R$": "BRL",
};

export function detectCurrency(input: string): string | undefined {
  const iso = /\b(USD|EUR|GBP|JPY|AUD|CAD|RUB|BRL|KRW|PLN)\b/i.exec(input)?.[1];
  if (iso) return iso.toUpperCase();

  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (input.includes(symbol)) return code;
  }
  return undefined;
}

/** Normalises AliExpress's protocol-relative and resized CDN image URLs. */
export function normalizeImageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(absolute)) return null;

  // Drop AliExpress's `_640x640.jpg`-style resize suffix to get the original.
  return absolute.replace(/_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)$/i, "");
}
