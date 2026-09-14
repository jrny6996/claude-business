import type { SecretName } from "@repo/db";
import {
  AI_PROVIDER_INFO,
  AiProviderSchema,
  AiSettingsSchema,
  AppError,
  BackupDestinationSchema,
  modelFor,
  type AiProvider,
  type AiSettings,
  type BackupDestination,
  type DeployProvider,
  type SettingsView,
  type Tier,
} from "@repo/shared";
import { createAiClient, validateStripeKey } from "@repo/store-generator";
import { LOCAL_USER_ID } from "@repo/db";
import { entitlementTier } from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";
import { readEntitlement } from "./account.js";

export const BACKUP_ENABLED_KEY = "backup.enabled";
export const BACKUP_DIR_KEY = "backup.dir";
export const BACKUP_DESTINATION_KEY = "backup.destination";
export const AI_PROVIDER_KEY = "ai.provider";
/** Per-provider model override, e.g. `ai.model.gemini`. */
export const AI_MODEL_KEY_PREFIX = "ai.model.";

/** Where each provider's BYOK key is stored. */
const AI_SECRET: Record<AiProvider, SecretName> = {
  openrouter: "openrouter_api_key",
  gemini: "gemini_api_key",
};

const DEPLOY_SECRET: Record<DeployProvider, SecretName> = {
  vercel: "deploy_token_vercel",
  netlify: "deploy_token_netlify",
};

/**
 * Settings and BYOK secret management.
 *
 * Note what this service never does: return a secret. `getSettings` returns
 * only {@link SecretMetadata}, so no route can accidentally serialise a key
 * back to the renderer.
 */
export function getSettings(ctx: AppContext): SettingsView {
  const { settings, users } = ctx.data;

  return {
    profile: users.ensureLocalUser(nowOf(ctx).toISOString()),
    openRouter: settings.describeSecret("openrouter_api_key"),
    gemini: settings.describeSecret("gemini_api_key"),
    ai: getAiSettings(ctx),
    stripe: settings.describeSecret("stripe_secret_key"),
    deployTokens: {
      vercel: settings.describeSecret("deploy_token_vercel"),
      netlify: settings.describeSecret("deploy_token_netlify"),
    },
    backupEnabled: settings.getBoolean(BACKUP_ENABLED_KEY),
    backupDir: settings.get(BACKUP_DIR_KEY),
    backupDestination: backupDestination(ctx),
    // Metadata only — the key itself is revealed through its own endpoint, so
    // it is never carried by the settings payload the UI polls.
    backupKeySet: settings.describeSecret("backup_encryption_key").present,
  };
}

/**
 * Stores an AI provider's key after checking it actually works.
 *
 * Validating on save is the difference between "AI features are broken" and
 * "that key was rejected, here's why" — worth one cheap request.
 *
 * Both providers are BYOK and are called directly from the user's machine.
 * Nothing here creates a key of ours or routes a request through us, and
 * switching provider changes only whose dashboard the usage lands on.
 */
export async function saveAiKey(
  ctx: AppContext,
  provider: AiProvider,
  apiKey: string,
): Promise<SettingsView> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new AppError(
      provider === "gemini" ? "MISSING_GEMINI_KEY" : "MISSING_OPENROUTER_KEY",
      `Paste your ${AI_PROVIDER_INFO[provider].label} API key to save it.`,
    );
  }

  const client = await createAiClient({
    provider,
    apiKey: trimmed,
    model: modelFor(getAiSettings(ctx), provider),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  await client.validateKey();

  const name = AI_SECRET[provider];
  const now = nowOf(ctx).toISOString();
  ctx.data.settings.writeSecret(name, trimmed, now);
  ctx.data.settings.markSecretValidated(name, now);

  return getSettings(ctx);
}

/** Kept as a named entry point; the OpenRouter path is just one provider now. */
export const saveOpenRouterKey = (
  ctx: AppContext,
  apiKey: string,
): Promise<SettingsView> => saveAiKey(ctx, "openrouter", apiKey);

export function getAiSettings(ctx: AppContext): AiSettings {
  const stored = ctx.data.settings.get(AI_PROVIDER_KEY);
  const provider = AiProviderSchema.safeParse(stored);

  const models: Partial<Record<AiProvider, string>> = {};
  for (const candidate of AiProviderSchema.options) {
    const model = ctx.data.settings.get(`${AI_MODEL_KEY_PREFIX}${candidate}`);
    if (model) models[candidate] = model;
  }

  return AiSettingsSchema.parse({
    provider: provider.success ? provider.data : "openrouter",
    models,
  });
}

/**
 * Chooses the provider AI features use, and optionally its model.
 *
 * Deliberately independent of which keys are stored: a user may keep both keys
 * and switch between them, and switching must never delete or expose a key.
 */
export function setAiPreferences(
  ctx: AppContext,
  { provider, model }: { provider: AiProvider; model?: string | null },
): SettingsView {
  ctx.data.settings.set(AI_PROVIDER_KEY, provider);

  if (model !== undefined) {
    const key = `${AI_MODEL_KEY_PREFIX}${provider}`;
    ctx.data.settings.set(key, model?.trim() || AI_PROVIDER_INFO[provider].defaultModel);
  }

  return getSettings(ctx);
}

export interface AiCredentials {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

/**
 * The single place an AI call gets its credentials.
 *
 * Returns null rather than throwing when no key is stored: every AI feature is
 * optional, and a missing key must degrade to a warning the user can act on,
 * never a failed store generation.
 */
export function resolveAiCredentials(ctx: AppContext): AiCredentials | null {
  const ai = getAiSettings(ctx);
  const apiKey = ctx.data.settings.readSecret(AI_SECRET[ai.provider]);
  if (!apiKey) return null;

  return { provider: ai.provider, apiKey, model: modelFor(ai, ai.provider) };
}

/** The error code to raise when the selected provider has no key. */
export function missingAiKeyCode(
  provider: AiProvider,
): "MISSING_OPENROUTER_KEY" | "MISSING_GEMINI_KEY" {
  return provider === "gemini" ? "MISSING_GEMINI_KEY" : "MISSING_OPENROUTER_KEY";
}

/** Stores the user's Stripe secret key, validated the same way. */
export async function saveStripeKey(
  ctx: AppContext,
  secretKey: string,
): Promise<SettingsView> {
  const trimmed = secretKey.trim();
  if (!trimmed) {
    throw new AppError(
      "MISSING_STRIPE_KEY",
      "Paste your Stripe secret key to save it.",
    );
  }

  await validateStripeKey(trimmed, ctx.fetchImpl);

  const now = nowOf(ctx).toISOString();
  ctx.data.settings.writeSecret("stripe_secret_key", trimmed, now);
  ctx.data.settings.markSecretValidated("stripe_secret_key", now);

  return getSettings(ctx);
}

export function saveDeployToken(
  ctx: AppContext,
  provider: DeployProvider,
  token: string,
): SettingsView {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new AppError(
      "MISSING_DEPLOY_TOKEN",
      "Paste a deploy token to save it.",
    );
  }

  ctx.data.settings.writeSecret(
    DEPLOY_SECRET[provider],
    trimmed,
    nowOf(ctx).toISOString(),
  );
  return getSettings(ctx);
}

export function deleteSecret(
  ctx: AppContext,
  name: SecretName,
): SettingsView {
  ctx.data.settings.deleteSecret(name);
  return getSettings(ctx);
}

export function backupDestination(ctx: AppContext): BackupDestination {
  const parsed = BackupDestinationSchema.safeParse(
    ctx.data.settings.get(BACKUP_DESTINATION_KEY),
  );
  return parsed.success ? parsed.data : "local";
}

export function setBackupPreferences(
  ctx: AppContext,
  {
    enabled,
    directory,
    destination,
  }: {
    enabled: boolean;
    directory: string | null;
    destination?: BackupDestination;
  },
): SettingsView {
  requirePremium(ctx, "Automated backups are a premium feature.");

  ctx.data.settings.setBoolean(BACKUP_ENABLED_KEY, enabled);
  if (directory !== null) ctx.data.settings.set(BACKUP_DIR_KEY, directory);
  if (destination) ctx.data.settings.set(BACKUP_DESTINATION_KEY, destination);

  return getSettings(ctx);
}

/**
 * The single place the app decides whether something is premium.
 *
 * Reads the cached entitlement, whose freshness is re-checked on every call, so
 * a lapsed subscription downgrades on its own.
 *
 * **This is a product gate, not a security boundary.** Everything it protects
 * runs on the user's machine, so it can be bypassed by anyone willing to edit a
 * file. That is fine, and is why the features that cost *us* money — cloud
 * backup — are gated again in the service against live account state, where the
 * client's opinion is irrelevant.
 */
export function requirePremium(ctx: AppContext, message: string): void {
  if (currentTier(ctx) !== "premium") {
    throw new AppError("PREMIUM_REQUIRED", message);
  }
}

/** The tier the app should behave as, right now. */
export function currentTier(ctx: AppContext): Tier {
  const { payload, reason } = readEntitlement(ctx);
  return entitlementTier(reason ? null : (payload ?? null), nowOf(ctx));
}

export { LOCAL_USER_ID };
