import type { NormalizedProduct } from "@repo/shared";
import { createAiClient, type AiClient, type AiClientOptions } from "./client.js";

const COPY_SYSTEM_PROMPT = `You write concise ecommerce product copy.
Return JSON only, matching exactly: {"description": string, "highlights": string[]}.
The description is 2-3 short paragraphs of plain text, no markdown.
Provide 3-5 highlights, each under 90 characters.
Never invent certifications, materials, guarantees, or health claims.`;

export interface RewrittenCopy {
  description: string;
  highlights: string[];
}

/** Either an already-built client, or the options to build one. */
export type AiSource = AiClient | AiClientOptions;

const clientFor = (source: AiSource): Promise<AiClient> =>
  "complete" in source ? Promise.resolve(source) : createAiClient(source);

/**
 * Rewrites scraped marketplace copy into something a storefront can use.
 *
 * Optional by design: a store generates perfectly well without it, and the
 * caller shows an "add your API key" prompt rather than failing the whole
 * generation. Provider-agnostic — the user's choice of OpenRouter or Gemini
 * changes nothing above this line.
 */
export async function rewriteProductCopy(
  product: NormalizedProduct,
  source: AiSource,
): Promise<RewrittenCopy> {
  const client = await clientFor(source);

  const input = [
    `Title: ${product.title}`,
    product.description
      ? `Existing description: ${product.description.slice(0, 2000)}`
      : "",
    product.highlights.length
      ? `Existing bullets: ${product.highlights.join(" | ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await client.complete(COPY_SYSTEM_PROMPT, input);
  return parseCopyResponse(raw, product);
}

/** Models sometimes wrap JSON in prose or a code fence; tolerate both. */
export function parseCopyResponse(
  raw: string,
  fallback: NormalizedProduct,
): RewrittenCopy {
  const parsed = parseJsonObject<Partial<RewrittenCopy>>(raw);

  if (parsed) {
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 5)
      : [];

    if (description) return { description, highlights };
  }

  return { description: fallback.description, highlights: fallback.highlights };
}

/** Generates alt text for product images. Also optional, also BYOK. */
export async function generateImageAltText(
  product: NormalizedProduct,
  source: AiSource,
): Promise<string[]> {
  if (product.images.length === 0) return [];

  const client = await clientFor(source);
  const raw = await client.complete(
    `You write short, factual image alt text for ecommerce photos.
Return JSON only: {"alt": string[]} with exactly the requested number of entries,
each under 120 characters. Describe only what a shopper would plausibly see.`,
    `Product: ${product.title}\nNumber of images: ${product.images.length}`,
  );

  const parsed = parseJsonObject<{ alt?: unknown }>(raw);
  const alt = Array.isArray(parsed?.alt)
    ? parsed.alt
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, product.images.length)
    : [];

  // Short of one entry per image, pad from the title rather than leaving an
  // image with no alt at all.
  return product.images.map((_, index) => alt[index] ?? product.title);
}

/**
 * Applies generated alt text to a product without disturbing anything else.
 *
 * Kept here so the caller never has to hand-merge model output into a
 * `NormalizedProduct` — an easy place to accidentally drop an image.
 */
export function withGeneratedAltText(
  product: NormalizedProduct,
  alt: string[],
): NormalizedProduct {
  if (alt.length === 0) return product;
  return {
    ...product,
    images: product.images.map((image, index) => {
      const text = alt[index]?.trim();
      return text ? { ...image, alt: text } : image;
    }),
  };
}

/** Pulls the first JSON object out of a model response, fence or no fence. */
function parseJsonObject<T>(raw: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
