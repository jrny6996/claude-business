import type { Entitlement } from "@repo/shared";
import { isPremiumNow, type AccountRecord } from "./accounts.js";

/**
 * What the desktop app is told it may do.
 *
 * Plain JSON. It is not signed, because every feature it gates runs on the
 * user's own machine — the gate that matters is the server-side one in
 * `auth.ts`, which checks live account state and cannot be talked out of it.
 */

/**
 * How long an entitlement is trusted, and when the app should renew it.
 *
 * The gap between the two is deliberate: the app refreshes after a day but the
 * answer stays good for two weeks, so a laptop that is offline for a fortnight
 * keeps working and a cancelled subscription still takes effect without us
 * needing to reach the machine. Shorter would punish offline users; longer
 * would let a cancellation linger.
 */
export const ENTITLEMENT_TTL_DAYS = 14;
export const ENTITLEMENT_REFRESH_HOURS = 24;

export function buildEntitlement(
  account: AccountRecord,
  now: Date,
): Entitlement {
  const premium = isPremiumNow(account, now);

  return {
    accountId: account.id,
    email: account.email,
    tier: premium ? "premium" : "free",
    status: account.status,
    periodEnd: account.periodEnd,
    refreshAfter: new Date(
      now.getTime() + ENTITLEMENT_REFRESH_HOURS * 3_600_000,
    ).toISOString(),
    expiresAt: new Date(
      now.getTime() + ENTITLEMENT_TTL_DAYS * 86_400_000,
    ).toISOString(),
    issuedAt: now.toISOString(),
  };
}
