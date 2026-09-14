import { AppError, type LicensePayload } from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";
import {
  accountForDeviceToken,
  isPremiumNow,
  type AccountRecord,
} from "./accounts.js";
import { accountNamespace, verifyLicenseKey } from "./issuer.js";

/**
 * Who is calling.
 *
 * Two credentials are accepted, and the order matters:
 *
 * 1. A **device token** from `POST /api/account/verify`. Durable, revocable by
 *    signing the device out, and checked against live account state — so a
 *    cancellation takes effect on the next call rather than at period end.
 * 2. A **signed licence key**, for customers who activated one before accounts
 *    existed. Still verified by signature alone, which means revocation is
 *    bounded by its expiry. This path exists for continuity and can go once
 *    none are in circulation.
 *
 * Still no passwords: sign-in proves control of an email address and is
 * exchanged for a token, so there is no password database to leak.
 */
export interface Caller {
  payload: LicensePayload;
  /** Hashed licence id. Every blob this caller owns is under this prefix. */
  namespace: string;
}

export async function authenticate(
  ctx: CloudContext,
  request: Request,
): Promise<Caller> {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");

  if (!scheme || scheme.toLowerCase() !== "bearer" || rest.length === 0) {
    throw new AppError(
      "UNAUTHORIZED",
      "Sign in to use cloud backup.",
      "missing bearer token",
    );
  }

  const credential = rest.join(" ").trim();

  // A device token is opaque and won't parse as a licence, so try it first
  // rather than reporting a signature failure for a perfectly good token.
  const account = await accountForDeviceToken(ctx, credential);
  if (account) return callerForAccount(ctx, account);

  const check = verifyLicenseKey(credential, {
    publicKeyPem: ctx.licensePublicKeyPem,
    now: nowOf(ctx),
  });

  if (!check.valid || !check.payload) {
    throw new AppError(
      "UNAUTHORIZED",
      check.reason ?? "That licence key isn't valid.",
    );
  }

  // Belt and braces: expiry is already checked above, but tier is not, and a
  // free licence must never reach paid storage.
  if (check.payload.tier !== "premium") {
    throw new AppError(
      "PREMIUM_REQUIRED",
      "Cloud backup is a premium feature.",
    );
  }

  return {
    payload: check.payload,
    namespace: accountNamespace(check.payload.id),
  };
}

function callerForAccount(ctx: CloudContext, account: AccountRecord): Caller {
  if (!isPremiumNow(account, nowOf(ctx))) {
    throw new AppError("PREMIUM_REQUIRED", "Cloud backup is a premium feature.");
  }

  return {
    payload: {
      v: 1,
      email: account.email,
      tier: "premium",
      expiresAt: account.periodEnd,
      issuedAt: account.updatedAt,
      id: account.id,
    },
    // Falls back to the account id only for an account that has never had a
    // subscription, which by definition has no backups to find.
    namespace: account.backupNamespace ?? accountNamespace(account.id),
  };
}
