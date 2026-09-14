import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKUP_ALGORITHM,
  BACKUP_ALGORITHM_HEADER,
  BACKUP_CREATED_AT_HEADER,
  AppError,
  type BackupList,
  type BackupUploadResult,
} from "@repo/shared";
import {
  decryptBackup,
  encryptBackup,
  formatBackupKey,
  generateBackupKey,
  parseBackupKey,
} from "@repo/db";
import { nowOf, type AppContext } from "../context.js";
import { requirePremium } from "./settings.js";

/**
 * Hosted backup, from the client side.
 *
 * The rule this whole feature hangs on: **the database is encrypted here, on
 * the user's machine, before it goes anywhere.** The service receives
 * ciphertext and a length, holds no key, and has no code path that could
 * decrypt one. That is what makes us paying to store this defensible instead of
 * a liability — a breach of that bucket leaks sizes and timestamps.
 *
 * It is an opt-in *alongside* the local-folder destination, never a replacement.
 * A hosted copy is only a backup if the local one can also fail.
 */
export { BACKUP_DESTINATION_KEY, backupDestination } from "./settings.js";

import { cloudBaseUrl } from "./cloud-url.js";

export { cloudBaseUrl };

/**
 * The user's backup encryption key, created on first use.
 *
 * Held in the same encrypted secret store as everything else, but it is the one
 * secret the user must also keep a copy of themselves: it is the only thing
 * that can open a cloud backup, and the point of a backup is surviving the loss
 * of the machine holding it.
 */
export function backupKey(ctx: AppContext): Buffer {
  const existing = ctx.data.settings.readSecret("backup_encryption_key");
  if (existing) return parseBackupKey(existing);

  const key = generateBackupKey();
  ctx.data.settings.writeSecret(
    "backup_encryption_key",
    formatBackupKey(key),
    nowOf(ctx).toISOString(),
  );
  return key;
}

/** The written-down form, for the user to save somewhere safe. */
export function recoveryKey(ctx: AppContext): string {
  return formatBackupKey(backupKey(ctx));
}

/**
 * Adopts a recovery key from another machine.
 *
 * Needed to restore on a new laptop: without the original key, that machine's
 * freshly generated one opens nothing.
 */
export function setRecoveryKey(ctx: AppContext, formatted: string): void {
  // Parsed before storing, so a mistyped key is rejected now rather than at
  // restore time, when the user is already having a bad day.
  const key = parseBackupKey(formatted);
  ctx.data.settings.writeSecret(
    "backup_encryption_key",
    formatBackupKey(key),
    nowOf(ctx).toISOString(),
  );
}

/** The device token, used as the credential for every hosted call. */
function deviceToken(ctx: AppContext): string {
  const token = ctx.data.settings.readSecret("device_token");
  if (!token) {
    throw new AppError(
      "UNAUTHORIZED",
      "Cloud backup needs you signed in. Sign in under Settings → Subscription.",
    );
  }
  return token;
}

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; detail?: string };
}

async function cloudRequest<T>(
  ctx: AppContext,
  method: string,
  path: string,
  body?: Uint8Array,
  headers: Record<string, string> = {},
): Promise<T> {
  const fetchImpl = (ctx.cloudFetchImpl ?? globalThis.fetch) as typeof globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AppError("CLOUD_REQUEST_FAILED", "No network client is available.");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${cloudBaseUrl(ctx)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${deviceToken(ctx)}`,
        ...headers,
      },
      ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
    });
  } catch {
    throw new AppError(
      "CLOUD_REQUEST_FAILED",
      "Couldn't reach the backup service. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    const error = envelope?.error;
    throw new AppError(
      // The service's own codes are already user-facing; anything unexpected
      // collapses rather than leaking a raw response.
      (error?.code as never) ?? "CLOUD_REQUEST_FAILED",
      error?.message ?? "The backup service rejected that request.",
      error?.detail,
    );
  }

  const envelope = (await response.json()) as Envelope<T>;
  if (!envelope.ok || envelope.value === undefined) {
    throw new AppError("CLOUD_REQUEST_FAILED", "The backup service sent an empty reply.");
  }
  return envelope.value;
}

/**
 * Snapshots the database, encrypts it, and uploads.
 *
 * The snapshot goes through SQLite's online backup API into a temp file first,
 * which gives a consistent copy under WAL where reading the live file would
 * not. The temp file is removed in a `finally` — it is the user's unencrypted
 * database sitting in the system temp directory, and leaving one behind would
 * undo the point of encrypting the upload.
 */
export async function uploadCloudBackup(
  ctx: AppContext,
): Promise<BackupUploadResult> {
  requirePremium(ctx, "Cloud backup is a premium feature.");

  const now = nowOf(ctx);
  const scratch = join(
    tmpdir(),
    `dsv-cloud-backup-${now.getTime()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );

  try {
    await ctx.data.db.backup(scratch);
    const plaintext = await readFile(scratch);
    const sealed = encryptBackup(plaintext, backupKey(ctx));

    return await cloudRequest<BackupUploadResult>(
      ctx,
      "POST",
      "/api/backup",
      sealed,
      {
        "Content-Type": "application/octet-stream",
        [BACKUP_CREATED_AT_HEADER]: now.toISOString(),
        [BACKUP_ALGORITHM_HEADER]: BACKUP_ALGORITHM,
      },
    );
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

export async function listCloudBackups(ctx: AppContext): Promise<BackupList> {
  requirePremium(ctx, "Cloud backup is a premium feature.");
  return cloudRequest<BackupList>(ctx, "GET", "/api/backup");
}

export async function deleteCloudBackup(
  ctx: AppContext,
  id: string,
): Promise<BackupList> {
  requirePremium(ctx, "Cloud backup is a premium feature.");
  return cloudRequest<BackupList>(
    ctx,
    "DELETE",
    `/api/backup/${encodeURIComponent(id)}`,
  );
}

export interface RestoreResult {
  /** Where the decrypted database was staged. */
  path: string;
  bytes: number;
  /** Restores take effect on the next launch — see the note below. */
  requiresRestart: true;
}

/**
 * Downloads and decrypts a backup, staging it for the next launch.
 *
 * Deliberately *not* an in-place swap. The database is open, with WAL files
 * beside it and statements prepared against it; replacing it underneath a
 * running app is how you corrupt someone's data while trying to rescue it.
 *
 * Instead the decrypted file is written next to the live one as
 * `pending-restore.sqlite`, and the main process adopts it on the next boot —
 * before anything opens a connection — keeping the previous database as a
 * dated file rather than deleting it.
 */
export async function restoreCloudBackup(
  ctx: AppContext,
  id: string,
): Promise<RestoreResult> {
  requirePremium(ctx, "Cloud backup is a premium feature.");

  if (!ctx.databaseDir) {
    throw new AppError(
      "INTERNAL",
      "This build can't restore a backup.",
      "databaseDir is not configured",
    );
  }

  const fetchImpl = (ctx.cloudFetchImpl ?? globalThis.fetch) as typeof globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `${cloudBaseUrl(ctx)}/api/backup/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${deviceToken(ctx)}` } },
    );
  } catch {
    throw new AppError(
      "CLOUD_REQUEST_FAILED",
      "Couldn't reach the backup service. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    throw new AppError(
      response.status === 404 ? "NOT_FOUND" : "CLOUD_REQUEST_FAILED",
      response.status === 404
        ? "That backup no longer exists."
        : "Couldn't download that backup.",
    );
  }

  const sealed = Buffer.from(await response.arrayBuffer());
  // Throws a legible error if this machine holds a different recovery key,
  // which is by far the most likely reason a restore fails.
  const plaintext = decryptBackup(sealed, backupKey(ctx));

  const target = join(ctx.databaseDir, PENDING_RESTORE_FILE);
  await writeFile(target, plaintext);

  return { path: target, bytes: plaintext.byteLength, requiresRestart: true };
}

/**
 * The staged-restore filename.
 *
 * Shared with the Electron main process, which looks for it before opening the
 * database. Hardcoding the same string in two places is exactly the kind of
 * thing that rots, so it lives here.
 */
export const PENDING_RESTORE_FILE = "pending-restore.sqlite";
