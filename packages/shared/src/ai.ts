import { z } from "zod";

/**
 * AI providers the app can talk to.
 *
 * Both are strictly BYOK and both are called **directly from the user's
 * machine** with the user's own key. We hold no key of our own, run no proxy,
 * and never see a token of this traffic — adding a second provider widens the
 * user's choice without moving a cent of inference cost onto us.
 */
export const AiProviderSchema = z.enum(["openrouter", "gemini"]);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const AI_PROVIDERS: readonly AiProvider[] = AiProviderSchema.options;

export interface AiProviderInfo {
  id: AiProvider;
  label: string;
  /** Where the user gets a key. Opened in their real browser, never in-app. */
  keyUrl: string;
  keyPlaceholder: string;
  /** Model used when the user hasn't picked one. */
  defaultModel: string;
  /**
   * Models offered in the picker. Free text is still accepted.
   *
   * These are provider model *ids*, not display names, and a wrong one fails
   * as a 404 that reads like a rejected key — so only ids verified against the
   * provider's own list belong here. Prefer stable ids over `-preview` ones:
   * a preview id is withdrawn when it graduates, which breaks the default for
   * everyone on the next release.
   */
  models: readonly string[];
}

export const AI_PROVIDER_INFO: Record<AiProvider, AiProviderInfo> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-v1-…",
    defaultModel: "anthropic/claude-haiku-4.5",
    models: [
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-5",
      "google/gemini-3.5-flash",
      "openai/gpt-5-mini",
      "meta-llama/llama-4-maverick",
    ],
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    defaultModel: "gemini-3.5-flash",
    models: [
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
  },
};

/** The user's AI configuration, as the settings screen sees it. */
export const AiSettingsSchema = z.object({
  /** Which provider AI features use. Independent of which keys are stored. */
  provider: AiProviderSchema.default("openrouter"),
  /** Chosen model per provider; absent means that provider's default. */
  models: z.partialRecord(AiProviderSchema, z.string().min(1)).default({}),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** The model a provider should use, honouring the user's override. */
export function modelFor(settings: AiSettings, provider: AiProvider): string {
  return settings.models[provider] ?? AI_PROVIDER_INFO[provider].defaultModel;
}
