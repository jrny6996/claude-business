import { createPrivateKey, sign } from "node:crypto";
import {
  encodeEntitlementPayload,
  type EntitlementPayload,
} from "@repo/shared";
import { isPremiumNow, type AccountRecord } from "./accounts.js";

/**
 * Minting the signed entitlement the desktop app trusts.
 *
 * Signed with the same issuer key as licences, so the app verifies both with
 * one public key and old licences keep working through the transition.
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
): EntitlementPayload {
  const premium = isPremiumNow(account, now);

  return {
    v: 1,
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

export function signEntitlement(
  payload: EntitlementPayload,
  privateKeyPem: string,
): string {
  const encoded = encodeEntitlementPayload(payload);
  const signature = sign(
    null,
    new TextEncoder().encode(encoded),
    createPrivateKey(privateKeyPem),
  );

  return `${encoded}.${signature.toString("base64url")}`;
}
