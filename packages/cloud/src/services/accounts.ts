import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";

/**
 * Accounts.
 *
 * The service used to hold no customer records at all — a signed licence was
 * the credential and Stripe was the database. That was a genuinely good
 * property, and it is being given up for one reason: a licence was minted per
 * billing period, so every renewal emailed the subscriber a new key to paste.
 * An account plus a durable device token means a renewal is invisible.
 *
 * What is stored is deliberately thin — an email, the Stripe ids, and the
 * subscription's current state. No passwords (sign-in is a mailed code), no
 * payment details, nothing we would not want to be asked to delete.
 *
 * Records live in the same blob store as backups rather than a database,
 * because the access pattern is a single key lookup and adding a database
 * would be a second thing to run, secure and pay for. The cost of that choice
 * is no transactions and no queries — see `findAccountByEmail`.
 */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "none";

export interface AccountRecord {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  status: SubscriptionStatus;
  /** ISO end of the paid period, when there is one. */
  periodEnd: string | null;
  /**
   * Where this account's backups live.
   *
   * Derived from the *licence* id, not the account id, because backups were
   * namespaced that way before accounts existed. Storing it means someone who
   * signs in with a device token reaches the blobs they already uploaded with
   * a key, instead of finding an empty account.
   */
  backupNamespace: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACCOUNT_PREFIX = "accounts/";
const DEVICE_PREFIX = "devices/";
const CODE_PREFIX = "signin-codes/";

/** Sign-in codes are short-lived by design; a stale one is worse than none. */
export const SIGNIN_CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

/**
 * Account ids are derived from the email so a lookup is one `get`, and hashed
 * so the key space doesn't leak a customer list to anyone who can list blobs.
 */
export function accountIdForEmail(email: string): string {
  const digest = createHash("sha256")
    .update(`dsv-account:${normalizeEmail(email)}`)
    .digest("hex");
  return `acct_${digest.slice(0, 24)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const accountKey = (id: string) => `${ACCOUNT_PREFIX}${id}.json`;
const deviceKey = (tokenHash: string) => `${DEVICE_PREFIX}${tokenHash}.json`;
const codeKey = (accountId: string) => `${CODE_PREFIX}${accountId}.json`;

function hashToken(token: string): string {
  return createHash("sha256").update(`dsv-token:${token}`).digest("hex");
}

async function readJson<T>(ctx: CloudContext, key: string): Promise<T | null> {
  const blob = await ctx.blobs.get(key);
  if (!blob) return null;
  try {
    return JSON.parse(new TextDecoder().decode(blob.bytes)) as T;
  } catch {
    return null;
  }
}

async function writeJson(
  ctx: CloudContext,
  key: string,
  value: unknown,
): Promise<void> {
  await ctx.blobs.put(
    key,
    new TextEncoder().encode(JSON.stringify(value)),
    {},
  );
}

export async function findAccountByEmail(
  ctx: CloudContext,
  email: string,
): Promise<AccountRecord | null> {
  return readJson<AccountRecord>(ctx, accountKey(accountIdForEmail(email)));
}

export async function findAccountById(
  ctx: CloudContext,
  id: string,
): Promise<AccountRecord | null> {
  return readJson<AccountRecord>(ctx, accountKey(id));
}

/** Creates the account if this email has never been seen. */
export async function ensureAccount(
  ctx: CloudContext,
  email: string,
): Promise<AccountRecord> {
  const existing = await findAccountByEmail(ctx, email);
  if (existing) return existing;

  const now = nowOf(ctx).toISOString();
  const account: AccountRecord = {
    id: accountIdForEmail(email),
    email: normalizeEmail(email),
    stripeCustomerId: null,
    subscriptionId: null,
    status: "none",
    periodEnd: null,
    backupNamespace: null,
    createdAt: now,
    updatedAt: now,
  };

  await writeJson(ctx, accountKey(account.id), account);
  return account;
}

/**
 * Records what Stripe says about a subscription.
 *
 * Called from the webhook, which is the only thing that may change a
 * subscription's state. Nothing a client sends can reach this.
 */
export async function applySubscriptionState(
  ctx: CloudContext,
  input: {
    email: string;
    stripeCustomerId: string | null;
    subscriptionId: string | null;
    status: SubscriptionStatus;
    periodEnd: string | null;
    /** Where this account's backups live; see `AccountRecord.backupNamespace`. */
    backupNamespace?: string | null;
  },
): Promise<AccountRecord> {
  const account = await ensureAccount(ctx, input.email);

  const updated: AccountRecord = {
    ...account,
    stripeCustomerId: input.stripeCustomerId ?? account.stripeCustomerId,
    subscriptionId: input.subscriptionId ?? account.subscriptionId,
    status: input.status,
    periodEnd: input.periodEnd,
    backupNamespace: input.backupNamespace ?? account.backupNamespace,
    updatedAt: nowOf(ctx).toISOString(),
  };

  await writeJson(ctx, accountKey(updated.id), updated);
  return updated;
}

/**
 * Whether an account is premium *right now*.
 *
 * `canceled` still counts while the paid period runs: someone who cancels has
 * paid through the period end and keeps what they bought. `past_due` also
 * counts, because a failed card retry should not lock someone out mid-session
 * — Stripe moves it to `canceled` if it stays unpaid.
 */
export function isPremiumNow(account: AccountRecord, now: Date): boolean {
  if (account.status === "none") return false;
  if (!account.periodEnd) return false;

  const end = Date.parse(account.periodEnd);
  if (Number.isNaN(end)) return false;

  return end > now.getTime();
}

interface SigninCodeRecord {
  codeHash: string;
  expiresAt: string;
  attempts: number;
}

/** Issues a one-time sign-in code and returns it for mailing. */
export async function issueSigninCode(
  ctx: CloudContext,
  email: string,
): Promise<{ account: AccountRecord; code: string }> {
  const account = await ensureAccount(ctx, email);

  // Six digits: short enough to retype from an email, and rate-limited below
  // so the small space doesn't matter.
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const expiresAt = new Date(
    nowOf(ctx).getTime() + SIGNIN_CODE_TTL_MINUTES * 60_000,
  ).toISOString();

  await writeJson(ctx, codeKey(account.id), {
    codeHash: hashToken(code),
    expiresAt,
    attempts: 0,
  } satisfies SigninCodeRecord);

  return { account, code };
}

/**
 * Exchanges a sign-in code for a durable device token.
 *
 * The token is what makes renewals invisible: the app keeps it and fetches a
 * fresh entitlement with it, instead of the user pasting a new key each period.
 */
export async function redeemSigninCode(
  ctx: CloudContext,
  email: string,
  code: string,
): Promise<{ account: AccountRecord; deviceToken: string }> {
  const account = await findAccountByEmail(ctx, email);
  const record = account ? await readJson<SigninCodeRecord>(ctx, codeKey(account.id)) : null;

  // One message for every failure: a distinct "no such account" would turn
  // this into a way to test whether an address is a customer.
  const rejected = new AppError(
    "UNAUTHORIZED",
    "That code isn't right, or it has expired. Request a new one.",
  );

  if (!account || !record) throw rejected;

  if (Date.parse(record.expiresAt) <= nowOf(ctx).getTime()) {
    await ctx.blobs.delete(codeKey(account.id));
    throw rejected;
  }

  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    await ctx.blobs.delete(codeKey(account.id));
    throw rejected;
  }

  const supplied = hashToken(code.trim());
  const matches =
    supplied.length === record.codeHash.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(record.codeHash));

  if (!matches) {
    // Counted so a wrong guess costs an attempt rather than being free.
    await writeJson(ctx, codeKey(account.id), {
      ...record,
      attempts: record.attempts + 1,
    } satisfies SigninCodeRecord);
    throw rejected;
  }

  await ctx.blobs.delete(codeKey(account.id));

  const deviceToken = randomBytes(32).toString("base64url");
  await writeJson(ctx, deviceKey(hashToken(deviceToken)), {
    accountId: account.id,
    createdAt: nowOf(ctx).toISOString(),
  });

  return { account, deviceToken };
}

/** Resolves a device token to its account, or null if it isn't ours. */
export async function accountForDeviceToken(
  ctx: CloudContext,
  token: string,
): Promise<AccountRecord | null> {
  const record = await readJson<{ accountId: string }>(
    ctx,
    deviceKey(hashToken(token.trim())),
  );
  if (!record) return null;
  return findAccountById(ctx, record.accountId);
}

/** Signs one device out. Other devices on the account keep working. */
export async function revokeDeviceToken(
  ctx: CloudContext,
  token: string,
): Promise<void> {
  await ctx.blobs.delete(deviceKey(hashToken(token.trim())));
}
