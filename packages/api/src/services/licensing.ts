import {
  AppError,
  formatLicenseHint,
  type LicensePayload,
  type Tier,
  type UserProfile,
} from "@repo/shared";
import { LOCAL_USER_ID } from "@repo/db";
import { nowOf, type AppContext } from "../context.js";
import { verifyLicenseKey } from "./license-keys.js";

/**
 * Licensing.
 *
 * Entitlement comes from a **signed licence key**, verified offline against an
 * embedded public key. This replaced an earlier version that simply believed
 * whatever tier the client asked for — anything deciding what a user has paid
 * for has to be verifiable, and nothing that ships to a user can mint a licence.
 *
 * The stored key is re-verified on every read rather than trusted from a
 * database column, so an expired licence downgrades on its own and there is no
 * stale-premium state to go wrong.
 *
 * This has nothing to do with the Stripe keys users bring for their own
 * storefronts. Those are their payments; this is ours.
 */
export interface LicenseStatus {
  profile: UserProfile;
  tier: Tier;
  expiresAt: string | null;
  /** Present when a licence is installed, whether or not it is still valid. */
  license: {
    hint: string;
    email: string;
    id: string;
    valid: boolean;
    reason?: string;
  } | null;
}

export function getLicenseStatus(ctx: AppContext): LicenseStatus {
  const now = nowOf(ctx);
  const key = ctx.data.settings.readSecret("license_key");

  if (!key) {
    return {
      profile: syncProfile(ctx, "free", null),
      tier: "free",
      expiresAt: null,
      license: null,
    };
  }

  const check = verifyLicenseKey(key, {
    ...(ctx.licensePublicKeyPem ? { publicKeyPem: ctx.licensePublicKeyPem } : {}),
    now,
  });

  const tier: Tier = check.valid && check.payload ? check.payload.tier : "free";
  const expiresAt = check.payload?.expiresAt ?? null;

  return {
    profile: syncProfile(ctx, tier, expiresAt, check.payload?.email ?? null),
    tier,
    expiresAt,
    license: {
      hint: formatLicenseHint(key),
      email: check.payload?.email ?? "",
      id: check.payload?.id ?? "",
      valid: check.valid,
      ...(check.reason ? { reason: check.reason } : {}),
    },
  };
}

/** Verifies and installs a licence key. Rejects anything unsigned. */
export function activateLicense(ctx: AppContext, key: string): LicenseStatus {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new AppError("VALIDATION_FAILED", "Paste your licence key to activate it.");
  }

  const check = verifyLicenseKey(trimmed, {
    ...(ctx.licensePublicKeyPem ? { publicKeyPem: ctx.licensePublicKeyPem } : {}),
    now: nowOf(ctx),
  });

  if (!check.valid) {
    throw new AppError(
      "VALIDATION_FAILED",
      check.reason ?? "That licence key isn't valid.",
    );
  }

  ctx.data.settings.writeSecret("license_key", trimmed, nowOf(ctx).toISOString());
  ctx.data.settings.markSecretValidated("license_key", nowOf(ctx).toISOString());

  return getLicenseStatus(ctx);
}

export function deactivateLicense(ctx: AppContext): LicenseStatus {
  ctx.data.settings.deleteSecret("license_key");
  return getLicenseStatus(ctx);
}

/** Mirrors the verified entitlement onto the profile row for convenience. */
function syncProfile(
  ctx: AppContext,
  tier: Tier,
  expiresAt: string | null,
  email: string | null = null,
): UserProfile {
  const current = ctx.data.users.ensureLocalUser(nowOf(ctx).toISOString());

  if (current.tier !== tier || current.premiumUntil !== expiresAt) {
    ctx.data.users.setEntitlement(LOCAL_USER_ID, tier, expiresAt);
  }
  if (email && current.email !== email) {
    ctx.data.users.setEmail(LOCAL_USER_ID, email);
  }

  return ctx.data.users.findById(LOCAL_USER_ID) ?? current;
}

export type { LicensePayload };
