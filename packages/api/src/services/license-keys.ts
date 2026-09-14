import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  checkEntitlementFreshness,
  decodeEntitlement,
  type EntitlementCheck,
  checkLicenseValidity,
  decodeLicenseKey,
  encodeLicensePayload,
  type LicenseCheck,
  type LicensePayload,
} from "@repo/shared";

/**
 * Ed25519 signing and verification for licence keys.
 *
 * Split deliberately: `verifyLicenseKey` needs only the public key and runs in
 * the desktop app, while `signLicensePayload` needs the private key and runs
 * only in the issuer. Nothing that ships to a user can mint a licence.
 */

/**
 * The public key licences are verified against.
 *
 * Overridable so the issuer's real key can be baked in at build time without
 * this file being the thing that has to change. The default is a development
 * key — a build that ships without setting this can only validate licences
 * signed by the dev key, which is the safe failure direction.
 */
export const LICENSE_PUBLIC_KEY_PEM =
  process.env.DSV_LICENSE_PUBLIC_KEY ??
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn5+y8VqlGwRcAPQEj0z5K6MDJznA6JpY8SeFsYlZ59A=
-----END PUBLIC KEY-----`;

export interface VerifyOptions {
  publicKeyPem?: string;
  now?: Date;
}

/**
 * Verifies a licence key's signature and expiry.
 *
 * Every failure mode returns a reason the UI can show, because "invalid
 * licence" with no explanation is the kind of thing that generates support
 * mail.
 */
export function verifyLicenseKey(
  key: string,
  { publicKeyPem = LICENSE_PUBLIC_KEY_PEM, now = new Date() }: VerifyOptions = {},
): LicenseCheck {
  const decoded = decodeLicenseKey(key);
  if (!decoded) {
    return {
      valid: false,
      reason: "That doesn't look like a licence key. Copy it again from your receipt.",
    };
  }

  const signatureOk = ((): boolean => {
    try {
      return verify(
        null,
        decoded.signedBytes,
        createPublicKey(publicKeyPem),
        decoded.signature,
      );
    } catch {
      // A malformed key or an unusable public key both mean "not genuine".
      return false;
    }
  })();

  if (!signatureOk) {
    return {
      valid: false,
      reason: "That licence key isn't genuine. Check it, or contact support.",
    };
  }

  return checkLicenseValidity(decoded.payload, now);
}

/** Signs a payload. Issuer-side only — needs the private key. */
export function signLicensePayload(
  payload: LicensePayload,
  privateKeyPem: string,
): string {
  const encoded = encodeLicensePayload(payload);
  const signature = sign(
    null,
    new TextEncoder().encode(encoded),
    createPrivateKey(privateKeyPem),
  );

  return `${encoded}.${signature
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

/** Generates an issuer key pair. Run once; keep the private key out of git. */
export function generateLicenseKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}

/**
 * Verifies a signed entitlement fetched from the hosted service.
 *
 * Same key as licences, so one public key covers both and a machine that still
 * holds an old licence keeps working while accounts roll out. Verified locally
 * for the same reason licences were: the app must not need our service to be
 * reachable in order to run.
 */
export function verifyEntitlementToken(
  token: string,
  { publicKeyPem = LICENSE_PUBLIC_KEY_PEM, now = new Date() }: VerifyOptions = {},
): EntitlementCheck {
  const decoded = decodeEntitlement(token);
  if (!decoded) {
    return { valid: false, reason: "That subscription record couldn't be read." };
  }

  const signatureOk = (() => {
    try {
      return verify(
        null,
        decoded.signedBytes,
        createPublicKey(publicKeyPem),
        decoded.signature,
      );
    } catch {
      return false;
    }
  })();

  if (!signatureOk) {
    return {
      valid: false,
      reason: "That subscription record isn't genuine. Sign in again.",
    };
  }

  return checkEntitlementFreshness(decoded.payload, now);
}
