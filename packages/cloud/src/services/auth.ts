import { AppError } from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";
import {
  accountForDeviceToken,
  isPremiumNow,
  type AccountRecord,
} from "./accounts.js";
import { accountNamespace } from "./namespaces.js";

/**
 * Who is calling, and whether they may.
 *
 * **This is the premium gate that actually matters.** Cloud backup is the one
 * feature we run and pay for, so it is enforced here against live account
 * state — not against anything the client presents. A cancelled subscriber
 * stops being able to upload the moment their paid period ends, regardless of
 * what their machine believes.
 *
 * The credential is a device token from `POST /api/account/verify`: a lookup,
 * so signing a device out takes effect immediately. There are still no
 * passwords — sign-in proves control of an email address — so there is no
 * password database to leak.
 */
export interface Caller {
  account: AccountRecord;
  /** Every blob this caller owns is under this prefix. */
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

  const account = await accountForDeviceToken(ctx, rest.join(" ").trim());
  if (!account) {
    throw new AppError(
      "UNAUTHORIZED",
      "This device is signed out. Sign in again to use cloud backup.",
    );
  }

  if (!isPremiumNow(account, nowOf(ctx))) {
    throw new AppError("PREMIUM_REQUIRED", "Cloud backup is a premium feature.");
  }

  return {
    account,
    // Falls back to the account id only for an account that has never had a
    // subscription, which by definition has no backups to find.
    namespace: account.backupNamespace ?? accountNamespace(account.id),
  };
}
