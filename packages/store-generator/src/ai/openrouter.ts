import { AI_PROVIDER_INFO, AppError } from "@repo/shared";
import { AiHttpError, requestText, type AiHttpOptions } from "./http.js";
import type { AiClient } from "./client.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Sensible, cheap default. The user can override it per call. */
export const DEFAULT_MODEL = AI_PROVIDER_INFO.openrouter.defaultModel;

/**
 * OpenRouter client — strictly BYOK.
 *
 * Calls go straight from the user's machine to OpenRouter with the user's own
 * key. We never proxy inference, never hold a key of our own, and never bill
 * a token of this to ourselves. Every caller must handle
 * {@link AppError} `MISSING_OPENROUTER_KEY` by prompting the user to add a key
 * rather than silently degrading.
 */
export interface OpenRouterOptions extends AiHttpOptions {
  apiKey: string;
  model?: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export class OpenRouterClient implements AiClient {
  readonly provider = "openrouter" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #http: AiHttpOptions;

  constructor({ apiKey, model = DEFAULT_MODEL, ...http }: OpenRouterOptions) {
    const key = apiKey.trim();
    if (!key) {
      throw new AppError(
        "MISSING_OPENROUTER_KEY",
        "Add your OpenRouter API key in Settings to use AI features.",
      );
    }
    this.#apiKey = key;
    this.model = model;
    this.#http = http;
  }

  async complete(system: string, user: string): Promise<string> {
    const raw = await this.#request("/chat/completions", {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1200,
    });

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
    try {
      return await requestText(
        `${OPENROUTER_API}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            // OpenRouter uses these for attribution on the user's own dashboard.
            "HTTP-Referer": "https://github.com/dropship-validator",
            "X-Title": "Dropshipping Store Validator",
          },
          ...(body === undefined ? {} : { body }),
        },
        this.#http,
      );
    } catch (cause) {
      throw toOpenRouterError(cause);
    }
  }
}

function toOpenRouterError(cause: unknown): AppError {
  if (!(cause instanceof AiHttpError)) {
    return new AppError(
      "OPENROUTER_REQUEST_FAILED",
      "The AI request failed. Try again in a moment.",
    );
  }

  if (cause.status === null) {
    return new AppError(
      "OPENROUTER_REQUEST_FAILED",
      "Couldn't reach OpenRouter. Check your connection and try again.",
    );
  }

  if (cause.status === 401 || cause.status === 403) {
    return new AppError(
      "MISSING_OPENROUTER_KEY",
      "OpenRouter rejected that API key. Check it in Settings.",
      `HTTP ${cause.status}`,
    );
  }

  if (cause.status === 402) {
    return new AppError(
      "OPENROUTER_REQUEST_FAILED",
      "Your OpenRouter account is out of credit.",
      "HTTP 402",
    );
  }

  return new AppError(
    "OPENROUTER_REQUEST_FAILED",
    "The AI request failed. Try again in a moment.",
    `HTTP ${cause.status}`,
  );
}
