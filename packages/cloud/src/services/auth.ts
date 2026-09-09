import { AppError, type LicensePayload } from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";
import { accountNamespace, verifyLicenseKey } from "./issuer.js";

/**
 * Who is calling.
 *
 * There are no accounts and no passwords anywhere in this product: a signed
 * licence *is* the credential. That is a real security property rather than a
 * shortcut — the service holds no password database to leak, and a licence
 * proves entitlement by signature without a lookup.
 *
 * It also means revocation is bounded by expiry. A leaked key works until the
 * subscription period ends, which is the trade for having no session state.
 * Periods are short enough (a year at most, with a 3-day grace) that this is
 * acceptable; if it stops being acceptable, the fix is a revocation list
 * checked here, not sessions.
 */
export interface Caller {
  payload: LicensePayload;
  /** Hashed licence id. Every blob this caller owns is under this prefix. */
  namespace: string;
}

export function authenticate(ctx: CloudContext, request: Request): Caller {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");

  if (!scheme || scheme.toLowerCase() !== "bearer" || rest.length === 0) {
    throw new AppError(
      "UNAUTHORIZED",
      "Sign in with your licence key to use cloud backup.",
      "missing bearer token",
    );
  }

  const check = verifyLicenseKey(rest.join(" ").trim(), {
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
