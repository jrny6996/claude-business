import { z } from "zod";
import type { Tier } from "./user.js";

/**
 * Licence keys.
 *
 * A licence is a signed, self-contained token: `payload.signature`, both
 * base64url. Verification needs only a public key, so the desktop app checks
 * entitlement **offline** and we never run a server on the critical path of
 * someone using the product they paid for.
 *
 * This exists because the earlier entitlement code simply trusted whatever the
 * client claimed. Anything that decides what a user has paid for has to be
 * verifiable, and this is the smallest thing that is.
 *
 * The signing key lives only with the issuer (see `packages/api/src/cloud`).
 * Nothing in the desktop app or the landing page can mint a licence.
 */
export const LicensePayloadSchema = z.object({
  /** Token format version, so old keys stay verifiable after changes. */
  v: z.literal(1),
  /** Who it was issued to. Shown in the app; not used as a secret. */
  email: z.email(),
  tier: z.enum(["free", "premium"]),
  /** ISO date the entitlement lapses. Null means perpetual. */
  expiresAt: z.iso.datetime().nullable(),
  /** ISO date of issue. */
  issuedAt: z.iso.datetime(),
  /** Opaque licence id, for support and revocation lists. */
  id: z.string().min(1),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export interface LicenseCheck {
  valid: boolean;
  payload?: LicensePayload;
  /** Why it failed, in language a user can act on. */
  reason?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Splits a licence key without verifying it. */
export function decodeLicenseKey(
  key: string,
): { payload: LicensePayload; signature: Uint8Array; signedBytes: Uint8Array } | null {
  const trimmed = key.trim().replace(/\s+/g, "");
  const parts = trimmed.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signaturePart] = parts as [string, string];
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  } catch {
    return null;
  }

  const payload = LicensePayloadSchema.safeParse(parsed);
  if (!payload.success) return null;

  return {
    payload: payload.data,
    signature: base64UrlDecode(signaturePart),
    // The signature covers the encoded payload exactly as transmitted, so
    // re-encoding it here would be a subtle way to break verification.
    signedBytes: new TextEncoder().encode(payloadPart),
  };
}

export function encodeLicensePayload(payload: LicensePayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Checks expiry only. Signature verification is platform-specific. */
export function checkLicenseValidity(
  payload: LicensePayload,
  now: Date,
): LicenseCheck {
  if (payload.expiresAt === null) return { valid: true, payload };

  const expiry = Date.parse(payload.expiresAt);
  if (Number.isNaN(expiry)) {
    return { valid: false, reason: "That licence has an invalid expiry date." };
  }
  if (expiry <= now.getTime()) {
    return {
      valid: false,
      payload,
      reason: `That licence expired on ${payload.expiresAt.slice(0, 10)}.`,
    };
  }
  return { valid: true, payload };
}

export function tierFromLicense(check: LicenseCheck): Tier {
  return check.valid && check.payload ? check.payload.tier : "free";
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** Groups a key for display without revealing it in full. */
export function formatLicenseHint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 12
    ? trimmed
    : `${trimmed.slice(0, 6)}…${trimmed.slice(-6)}`;
}
