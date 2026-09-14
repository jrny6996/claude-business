import { AI_PROVIDER_INFO, AppError } from "@repo/shared";
import { AiHttpError, requestText, type AiHttpOptions } from "./http.js";
import type { AiClient } from "./client.js";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_GEMINI_MODEL = AI_PROVIDER_INFO.gemini.defaultModel;

/**
 * Google Gemini client — strictly BYOK, exactly like OpenRouter.
 *
 * The key is the user's own Google AI Studio key, it is read from their
 * encrypted local store at the moment of use, and the request goes from their
 * machine straight to Google. No key of ours exists, nothing is proxied, and
 * the usage lands on their billing account, not ours.
 *
 * The one thing worth knowing about this API: the system prompt is a separate
 * `system_instruction` field rather than a message with a role, so it can't be
 * expressed as an OpenAI-style message array.
 */
export interface GeminiOptions extends AiHttpOptions {
  apiKey: string;
  model?: string;
}

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient implements AiClient {
  readonly provider = "gemini" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #http: AiHttpOptions;

  constructor({ apiKey, model = DEFAULT_GEMINI_MODEL, ...http }: GeminiOptions) {
    const key = apiKey.trim();
    if (!key) {
      throw new AppError(
        "MISSING_GEMINI_KEY",
        "Add your Google Gemini API key in Settings to use AI features.",
      );
    }
    this.#apiKey = key;
    this.model = model;
    this.#http = http;
  }

  async complete(system: string, user: string): Promise<string> {
    const raw = await this.#request(
      `/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1200, temperature: 0.7 },
      },
    );

    const parsed = JSON.parse(raw) as GenerateContentResponse;

    // A safety block returns 200 with no candidate, which would otherwise look
    // identical to an empty model response.
    const blocked =
      parsed.promptFeedback?.blockReason ??
      parsed.candidates?.[0]?.finishReason === "SAFETY";
    if (blocked) {
      throw new AppError(
        "GEMINI_REQUEST_FAILED",
        "Gemini declined to rewrite this listing's copy. The original text was kept.",
      );
    }

    const content = parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!content) {
      throw new AppError(
        "GEMINI_REQUEST_FAILED",
        "The AI model returned an empty response. Try again.",
      );
    }
    return content;
  }

  /** Cheap authenticated call used to validate a pasted key. */
  async validateKey(): Promise<boolean> {
    await this.#request("/models?pageSize=1", undefined, "GET");
    return true;
  }

  async #request(
    path: string,
    body?: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<string> {
    try {
      return await requestText(
        `${GEMINI_API}${path}`,
        {
          method,
          // Header auth, not `?key=` — a key in a query string ends up in logs
          // and in any error message that echoes the URL back.
          headers: {
            "x-goog-api-key": this.#apiKey,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body }),
        },
        this.#http,
      );
    } catch (cause) {
      throw toGeminiError(cause);
    }
  }
}

/**
 * Maps transport failures onto messages the user can act on.
 *
 * Google reports a bad key as a 400 with an `API_KEY_INVALID` reason as often
 * as it does a 401, so the body is inspected rather than trusting the status
 * alone — otherwise a wrong key reads as "something went wrong".
 */
function toGeminiError(cause: unknown): AppError {
  if (!(cause instanceof AiHttpError)) {
    return new AppError(
      "GEMINI_REQUEST_FAILED",
      "The AI request failed. Try again in a moment.",
    );
  }

  if (cause.status === null) {
    return new AppError(
      "GEMINI_REQUEST_FAILED",
      "Couldn't reach Google Gemini. Check your connection and try again.",
    );
  }

  const looksLikeKeyProblem =
    cause.status === 401 ||
    cause.status === 403 ||
    (cause.status === 400 && /API_KEY_INVALID|api key not valid/i.test(cause.body));

  if (looksLikeKeyProblem) {
    return new AppError(
      "MISSING_GEMINI_KEY",
      "Google rejected that Gemini API key. Check it in Settings.",
      `HTTP ${cause.status}`,
    );
  }

  if (cause.status === 429) {
    return new AppError(
      "GEMINI_REQUEST_FAILED",
      "Your Gemini account is over its rate limit or quota. Try again shortly.",
      "HTTP 429",
    );
  }

  if (cause.status === 404) {
    return new AppError(
      "GEMINI_REQUEST_FAILED",
      "That Gemini model isn't available to your key. Pick another in Settings.",
      "HTTP 404",
    );
  }

  return new AppError(
    "GEMINI_REQUEST_FAILED",
    "The AI request failed. Try again in a moment.",
    `HTTP ${cause.status}`,
  );
}
