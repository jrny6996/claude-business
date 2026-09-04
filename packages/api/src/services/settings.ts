import type { SecretName } from "@repo/db";
import {
  AppError,
  type DeployProvider,
  type SettingsView,
  type Tier,
} from "@repo/shared";
import { validateStripeKey } from "@repo/store-generator";
import { OpenRouterClient } from "@repo/store-generator";
import { LOCAL_USER_ID } from "@repo/db";
import { nowOf, type AppContext } from "../context.js";

export const BACKUP_ENABLED_KEY = "backup.enabled";
export const BACKUP_DIR_KEY = "backup.dir";

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
    stripe: settings.describeSecret("stripe_secret_key"),
    deployTokens: {
      vercel: settings.describeSecret("deploy_token_vercel"),
      netlify: settings.describeSecret("deploy_token_netlify"),
    },
    backupEnabled: settings.getBoolean(BACKUP_ENABLED_KEY),
    backupDir: settings.get(BACKUP_DIR_KEY),
  };
}

/**
 * Stores the user's OpenRouter key after checking it actually works.
 *
 * Validating on save is the difference between "AI features are broken" and
 * "that key was rejected, here's why" — worth one cheap request.
 */
export async function saveOpenRouterKey(
  ctx: AppContext,
  apiKey: string,
): Promise<SettingsView> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new AppError(
      "MISSING_OPENROUTER_KEY",
      "Paste your OpenRouter API key to save it.",
    );
  }

  const client = new OpenRouterClient(
    ctx.fetchImpl ? { apiKey: trimmed, fetchImpl: ctx.fetchImpl } : { apiKey: trimmed },
  );
  await client.validateKey();

  const now = nowOf(ctx).toISOString();
  ctx.data.settings.writeSecret("openrouter_api_key", trimmed, now);
  ctx.data.settings.markSecretValidated("openrouter_api_key", now);

  return getSettings(ctx);
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

export function setBackupPreferences(
  ctx: AppContext,
  { enabled, directory }: { enabled: boolean; directory: string | null },
): SettingsView {
  requirePremium(ctx, "Automated backups are a premium feature.");

  ctx.data.settings.setBoolean(BACKUP_ENABLED_KEY, enabled);
  if (directory !== null) ctx.data.settings.set(BACKUP_DIR_KEY, directory);

  return getSettings(ctx);
}

/**
 * The single place entitlement is enforced.
 *
 * Licensing itself is intentionally minimal and local for now — see the note
 * in `licensing.ts`. Every premium gate routes through here so swapping in a
 * real check is one edit.
 */
export function requirePremium(ctx: AppContext, message: string): void {
  const profile = ctx.data.users.ensureLocalUser(nowOf(ctx).toISOString());
  if (effectiveTier(profile.tier, profile.premiumUntil, nowOf(ctx)) !== "premium") {
    throw new AppError("PREMIUM_REQUIRED", message);
  }
}

/** A lapsed `premiumUntil` silently downgrades to free. */
export function effectiveTier(
  tier: Tier,
  premiumUntil: string | null,
  now: Date,
): Tier {
  if (tier !== "premium") return "free";
  if (premiumUntil === null) return "premium";

  const expiry = Date.parse(premiumUntil);
  if (Number.isNaN(expiry)) return "free";
  return expiry > now.getTime() ? "premium" : "free";
}

export { LOCAL_USER_ID };
