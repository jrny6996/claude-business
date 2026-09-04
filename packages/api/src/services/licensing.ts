import { AppError, type Tier, type UserProfile } from "@repo/shared";
import { LOCAL_USER_ID } from "@repo/db";
import { nowOf, type AppContext } from "../context.js";
import { effectiveTier } from "./settings.js";

/**
 * Licensing.
 *
 * Deliberately local and minimal. A real implementation checks a signed
 * entitlement against our licensing service — that service is one of the few
 * things we *do* host, because it's a few bytes of JSON per user rather than
 * media or inference. Until the pricing model is settled this only records
 * what the user already has, and every premium gate goes through
 * `requirePremium` in `settings.ts` so there is exactly one place to change.
 *
 * It does not talk to a payment processor, and it has nothing to do with the
 * Stripe keys users bring for their own storefronts — those two must never be
 * confused.
 */
export interface LicenseStatus {
  profile: UserProfile;
  /** Tier after expiry is taken into account. */
  tier: Tier;
  expiresAt: string | null;
}

export function getLicenseStatus(ctx: AppContext): LicenseStatus {
  const now = nowOf(ctx);
  const profile = ctx.data.users.ensureLocalUser(now.toISOString());

  return {
    profile,
    tier: effectiveTier(profile.tier, profile.premiumUntil, now),
    expiresAt: profile.premiumUntil,
  };
}

/**
 * Records an entitlement locally.
 *
 * Signature verification against our licensing service is the missing piece
 * here and is flagged for review rather than guessed at, since it decides what
 * we charge for.
 */
export function applyLicense(
  ctx: AppContext,
  { tier, expiresAt }: { tier: Tier; expiresAt: string | null },
): LicenseStatus {
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    throw new AppError("VALIDATION_FAILED", "That licence expiry date isn't valid.");
  }

  const updated = ctx.data.users.setEntitlement(LOCAL_USER_ID, tier, expiresAt);
  if (!updated) throw new AppError("INTERNAL", "Couldn't record that licence.");

  return getLicenseStatus(ctx);
}
