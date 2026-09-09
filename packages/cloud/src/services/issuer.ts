import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  AppError,
  checkLicenseValidity,
  decodeLicenseKey,
  encodeLicensePayload,
  type LicenseCheck,
  type LicensePayload,
} from "@repo/shared";

/**
 * The issuer. The one thing in this system that can mint a licence.
 *
 * `packages/api/src/services/license-keys.ts` deliberately ships only the
 * verify half to users; this is the other half, and it exists exclusively in
 * the hosted service. The signing key is read from the environment and never
 * touches the repository.
 */

/**
 * Derives a stable licence id from a Stripe subscription.
 *
 * Stability across renewals is the point. A subscriber gets a fresh licence
 * every billing period with a new expiry, and if the id changed with it, their
 * cloud backups — namespaced by licence id — would be orphaned once a year.
 *
 * Hashed rather than used raw so the licence, which the user pastes into
 * support tickets and forums, doesn't carry a live Stripe object id.
 */
export function licenseIdForSubscription(subscriptionId: string): string {
  const digest = createHash("sha256")
    .update(`dsv-license:${subscriptionId}`)
    .digest("hex");
  return `lic_${digest.slice(0, 16)}`;
}

export interface IssueLicenseInput {
  email: string;
  subscriptionId: string;
  /** Unix seconds the paid period ends — becomes the licence expiry. */
  periodEnd: number;
  issuedAt: Date;
}

/**
 * Mints a premium licence for a paid subscription period.
 *
 * The expiry is the subscription's period end plus a grace window. Without the
 * grace, a renewal that is a few minutes late downgrades a paying customer
 * mid-session; with it, a genuinely cancelled subscription still lapses on its
 * own, because the app re-verifies the licence on every read.
 */
export const RENEWAL_GRACE_DAYS = 3;

export function issueLicense(
  { email, subscriptionId, periodEnd, issuedAt }: IssueLicenseInput,
  privateKeyPem: string,
): { key: string; payload: LicensePayload } {
  const expiry = new Date(
    periodEnd * 1000 + RENEWAL_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );

  const payload: LicensePayload = {
    v: 1,
    email,
    tier: "premium",
    expiresAt: expiry.toISOString(),
    issuedAt: issuedAt.toISOString(),
    id: licenseIdForSubscription(subscriptionId),
  };

  return { key: signLicensePayload(payload, privateKeyPem), payload };
}

/** Signs a payload. Needs the private key, so this runs only in the issuer. */
export function signLicensePayload(
  payload: LicensePayload,
  privateKeyPem: string,
): string {
  if (!privateKeyPem.trim()) {
    throw new AppError(
      "CLOUD_REQUEST_FAILED",
      "The licensing service isn't configured to issue licences.",
      "DSV_LICENSE_PRIVATE_KEY is not set",
    );
  }

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

/**
 * Verifies a licence presented as a credential.
 *
 * The same check the desktop app performs, running here because the backup
 * endpoints have to know who is calling. It needs only the public key — the
 * service authenticates callers without its signing key being involved.
 */
export function verifyLicenseKey(
  key: string,
  { publicKeyPem, now }: { publicKeyPem: string; now: Date },
): LicenseCheck {
  const decoded = decodeLicenseKey(key);
  if (!decoded) {
    return { valid: false, reason: "That doesn't look like a licence key." };
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
      return false;
    }
  })();

  if (!signatureOk) {
    return { valid: false, reason: "That licence key isn't genuine." };
  }

  return checkLicenseValidity(decoded.payload, now);
}

/**
 * The storage namespace for an account.
 *
 * Hashed so no email address and no licence key material appears in a blob
 * key. Storage listings, logs and provider dashboards therefore carry nothing
 * that identifies a person.
 */
export function accountNamespace(licenseId: string): string {
  return createHash("sha256").update(`dsv-account:${licenseId}`).digest("hex");
}
