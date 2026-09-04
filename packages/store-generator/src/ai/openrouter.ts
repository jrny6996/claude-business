import { AppError, type NormalizedProduct } from "@repo/shared";
import type { FetchLike } from "../scrape/fetch.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Sensible, cheap default. The user can override it per call. */
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

/**
 * OpenRouter client — strictly BYOK.
 *
 * Calls go straight from the user's machine to OpenRouter with the user's own
 * key. We never proxy inference, never hold a key of our own, and never bill
 * a token of this to ourselves. Every caller must handle
 * {@link AppError} `MISSING_OPENROUTER_KEY` by prompting the user to add a key
 * rather than silently degrading.
 */
export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export class OpenRouterClient {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl,
    timeoutMs = 60_000,
  }: OpenRouterOptions) {
    const key = apiKey.trim();
    if (!key) {
      throw new AppError(
        "MISSING_OPENROUTER_KEY",
        "Add your OpenRouter API key in Settings to use AI features.",
      );
    }
    this.#apiKey = key;
    this.#model = model;
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#timeoutMs = timeoutMs;
  }

  async complete(system: string, user: string): Promise<string> {
    const body = {
      model: this.#model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1200,
    };

    const raw = await this.#request("/chat/completions", body);
    const parsed = JSON.parse(raw) as ChatResponse;
    const content = parsed.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new AppError(
        "OPENROUTER_REQUEST_FAILED",
        "The AI model returned an empty response. Try again.",
      );
    }
    return content;
  }

  /** Cheap authenticated call used to validate a pasted key. */
  async validateKey(): Promise<boolean> {
    await this.#request("/key", undefined, "GET");
    return true;
  }

  async #request(
    path: string,
    body?: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<string> {
    if (typeof this.#fetch !== "function") {
      throw new AppError(
        "OPENROUTER_REQUEST_FAILED",
        "No network client is available.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await (
        this.#fetch as unknown as (
          input: string,
          init: Record<string, unknown>,
        ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
      )(`${OPENROUTER_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter uses these for attribution on the user's own dashboard.
          "HTTP-Referer": "https://github.com/dropship-validator",
          "X-Title": "Dropshipping Store Validator",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new AppError(
          response.status === 401 || response.status === 403
            ? "MISSING_OPENROUTER_KEY"
            : "OPENROUTER_REQUEST_FAILED",
          response.status === 401 || response.status === 403
            ? "OpenRouter rejected that API key. Check it in Settings."
            : response.status === 402
              ? "Your OpenRouter account is out of credit."
              : "The AI request failed. Try again in a moment.",
          `HTTP ${response.status}`,
        );
      }

      return text;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "OPENROUTER_REQUEST_FAILED",
        "Couldn't reach OpenRouter. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const COPY_SYSTEM_PROMPT = `You write concise ecommerce product copy.
Return JSON only, matching exactly: {"description": string, "highlights": string[]}.
The description is 2-3 short paragraphs of plain text, no markdown.
Provide 3-5 highlights, each under 90 characters.
Never invent certifications, materials, guarantees, or health claims.`;

export interface RewrittenCopy {
  description: string;
  highlights: string[];
}

/**
 * Rewrites scraped marketplace copy into something a storefront can use.
 *
 * Optional by design: a store generates perfectly well without it, and the
 * caller shows an "add your OpenRouter key" prompt rather than failing the
 * whole generation.
 */
export async function rewriteProductCopy(
  product: NormalizedProduct,
  options: OpenRouterOptions,
): Promise<RewrittenCopy> {
  const client = new OpenRouterClient(options);

  const source = [
    `Title: ${product.title}`,
    product.description ? `Existing description: ${product.description.slice(0, 2000)}` : "",
    product.highlights.length ? `Existing bullets: ${product.highlights.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await client.complete(COPY_SYSTEM_PROMPT, source);
  return parseCopyResponse(raw, product);
}

/** Models sometimes wrap JSON in prose or a code fence; tolerate both. */
export function parseCopyResponse(
  raw: string,
  fallback: NormalizedProduct,
): RewrittenCopy {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<RewrittenCopy>;
      const description =
        typeof parsed.description === "string" ? parsed.description.trim() : "";
      const highlights = Array.isArray(parsed.highlights)
        ? parsed.highlights.filter((h): h is string => typeof h === "string").slice(0, 5)
        : [];

      if (description) return { description, highlights };
    } catch {
      // Fall through to the un-rewritten copy below.
    }
  }

  return { description: fallback.description, highlights: fallback.highlights };
}

/** Generates alt text for product images. Also optional, also BYOK. */
export async function generateImageAltText(
  product: NormalizedProduct,
  options: OpenRouterOptions,
): Promise<string[]> {
  if (product.images.length === 0) return [];

  const client = new OpenRouterClient(options);
  const raw = await client.complete(
    `You write short, factual image alt text for ecommerce photos.
Return JSON only: {"alt": string[]} with exactly the requested number of entries,
each under 120 characters. Describe only what a shopper would plausibly see.`,
    `Product: ${product.title}\nNumber of images: ${product.images.length}`,
  );

  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { alt?: unknown };
    if (Array.isArray(parsed.alt)) {
      return parsed.alt
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, product.images.length);
    }
  } catch {
    // Non-fatal: callers fall back to the product title as alt text.
  }

  return product.images.map(() => product.title);
}
