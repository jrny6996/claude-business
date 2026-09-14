import { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "./license.js";

/**
 * A signed statement of what an account is currently entitled to.
 *
 * This replaces the licence key as the thing the desktop app trusts. The
 * difference that matters: a licence was minted per billing period and had to
 * be re-delivered and re-pasted at every renewal. An entitlement is fetched by
 * the app itself using a durable device token, so a subscriber renews and
 * notices nothing.
 *
 * Still signed, and still verified offline, for the same reason as before: the
 * app must not need our service to be reachable in order to work. `expiresAt`
 * is short — the app keeps working while offline and stops trusting a stale
 * answer once it lapses, which is also what makes a cancellation take effect
 * without us having to reach the machine.
 */
export const EntitlementPayloadSchema = z.object({
  v: z.literal(1),
  /** Stable, opaque account id. Derived from the email, never the email itself. */
  accountId: z.string().min(1),
  email: z.email(),
  tier: z.enum(["free", "premium"]),
  /** Mirrors Stripe, so the UI can distinguish "lapsed" from "payment failed". */
  status: z.enum(["active", "trialing", "past_due", "canceled", "none"]),
  /** End of the paid period, when there is one. */
  periodEnd: z.iso.datetime().nullable(),
  /** When the app should try to refresh. Before `expiresAt`, so it has room. */
  refreshAfter: z.iso.datetime(),
  /** When the app must stop trusting this. */
  expiresAt: z.iso.datetime(),
  issuedAt: z.iso.datetime(),
});
export type EntitlementPayload = z.infer<typeof EntitlementPayloadSchema>;

export interface EntitlementCheck {
  valid: boolean;
  payload?: EntitlementPayload;
  reason?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Splits a signed entitlement without verifying it. */
export function decodeEntitlement(token: string): {
  payload: EntitlementPayload;
  signature: Uint8Array;
  signedBytes: Uint8Array;
} | null {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signaturePart] = parts as [string, string];
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  } catch {
    return null;
  }

  const payload = EntitlementPayloadSchema.safeParse(parsed);
  if (!payload.success) return null;

  return {
    payload: payload.data,
    signature: base64UrlDecode(signaturePart),
    // The signature covers the encoded payload exactly as transmitted.
    signedBytes: new TextEncoder().encode(payloadPart),
  };
}

export function encodeEntitlementPayload(payload: EntitlementPayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Expiry check only; signature verification is platform-specific. */
export function checkEntitlementFreshness(
  payload: EntitlementPayload,
  now: Date,
): EntitlementCheck {
  if (Date.parse(payload.expiresAt) <= now.getTime()) {
    return {
      valid: false,
      payload,
      reason:
        "Your subscription status is out of date. Connect to the internet so the app can check it.",
    };
  }
  return { valid: true, payload };
}

/** Whether the app should go and fetch a newer one. */
export function shouldRefreshEntitlement(
  payload: EntitlementPayload,
  now: Date,
): boolean {
  return Date.parse(payload.refreshAfter) <= now.getTime();
}
