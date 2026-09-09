import { AppError, type AiProvider } from "@repo/shared";
import type { AiHttpOptions } from "./http.js";

/**
 * What the rest of the app is allowed to know about an AI provider.
 *
 * Everything above this line (copy rewriting, alt text) is written against
 * this interface, so adding a provider is one new file plus one case in
 * {@link createAiClient} — no caller changes, and no chance of a provider
 * sneaking a proxied call in through a side door.
 */
export interface AiClient {
  readonly provider: AiProvider;
  readonly model: string;
  complete(system: string, user: string): Promise<string>;
  /** Cheap authenticated call, used to check a pasted key actually works. */
  validateKey(): Promise<boolean>;
}

export interface AiClientOptions extends AiHttpOptions {
  /** Defaults to OpenRouter, which is what every existing caller used. */
  provider?: AiProvider;
  apiKey: string;
  model?: string;
}

/** The error code to raise when a given provider has no key stored. */
export const MISSING_KEY_CODE = {
  openrouter: "MISSING_OPENROUTER_KEY",
  gemini: "MISSING_GEMINI_KEY",
} as const;

export async function createAiClient(
  options: AiClientOptions,
): Promise<AiClient> {
  const provider: AiProvider = options.provider ?? "openrouter";

  // Imported lazily and per-provider so a client is only ever constructed for
  // the provider actually in use.
  if (provider === "gemini") {
    const { GeminiClient } = await import("./gemini.js");
    return new GeminiClient(options);
  }
  if (provider === "openrouter") {
    const { OpenRouterClient } = await import("./openrouter.js");
    return new OpenRouterClient(options);
  }

  throw new AppError(
    "MISSING_AI_KEY",
    `"${String(provider)}" isn't an AI provider this app knows about.`,
  );
}
