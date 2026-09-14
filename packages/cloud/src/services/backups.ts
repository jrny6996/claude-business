import { randomUUID } from "node:crypto";
import {
  AppError,
  BACKUP_ALGORITHM,
  type BackupList,
  type BackupManifest,
  type BackupQuota,
  type BackupUploadResult,
} from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";
import type { Caller } from "./auth.js";

/**
 * Hosted backups.
 *
 * The service stores ciphertext and a length. It has no key, no key-derivation
 * input, and no code path that decrypts — the desktop app encrypts before
 * upload with a key it never sends. That is the property that makes paying for
 * this storage a reasonable business decision rather than a liability: a full
 * breach of this bucket leaks the sizes and timestamps of some backups and
 * nothing else.
 *
 * It is also an opt-in *alongside* the local-folder destination, never a
 * replacement for it. A hosted copy is only a backup if the local one can also
 * fail.
 */
const MANIFEST_KEYS = {
  createdAt: "createdAt",
  uploadedAt: "uploadedAt",
  algorithm: "algorithm",
  sizeBytes: "sizeBytes",
} as const;

const blobKey = (namespace: string, id: string): string =>
  `backups/${namespace}/${id}`;

export async function listBackups(
  ctx: CloudContext,
  caller: Caller,
): Promise<BackupList> {
  const backups = await readManifests(ctx, caller);
  return { backups, quota: quotaOf(ctx, backups) };
}

export interface UploadInput {
  ciphertext: Uint8Array;
  /** The desktop app's own timestamp for the snapshot. */
  createdAt: string | null;
  algorithm: string | null;
}

export async function uploadBackup(
  ctx: CloudContext,
  caller: Caller,
  { ciphertext, createdAt, algorithm }: UploadInput,
): Promise<BackupUploadResult> {
  const { maxUploadBytes, quotaBytes, maxBackups } = ctx.config;

  if (ciphertext.byteLength === 0) {
    throw new AppError("VALIDATION_FAILED", "That backup was empty.");
  }
  if (ciphertext.byteLength > maxUploadBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `That backup is ${mb(ciphertext.byteLength)} and the limit is ${mb(maxUploadBytes)}. Back up to a local folder instead.`,
    );
  }

  const now = nowOf(ctx);
  const existing = await readManifests(ctx, caller);

  // Retention first, so a user at their backup limit can always take a new
  // one — the oldest going is the expected behaviour, not a rejection.
  const keep = existing.slice(0, Math.max(0, maxBackups - 1));
  const pruned = existing.slice(Math.max(0, maxBackups - 1));

  for (const manifest of pruned) {
    await ctx.blobs.delete(blobKey(caller.namespace, manifest.id));
  }

  const usedAfterPrune = keep.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (usedAfterPrune + ciphertext.byteLength > quotaBytes) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      `That would put you over your ${mb(quotaBytes)} of cloud backup. Delete an older backup and try again.`,
    );
  }

  const manifest: BackupManifest = {
    id: randomUUID(),
    sizeBytes: ciphertext.byteLength,
    createdAt: isoOr(createdAt, now),
    uploadedAt: now.toISOString(),
    algorithm: algorithm?.trim() || BACKUP_ALGORITHM,
  };

  await ctx.blobs.put(blobKey(caller.namespace, manifest.id), ciphertext, {
    [MANIFEST_KEYS.createdAt]: manifest.createdAt,
    [MANIFEST_KEYS.uploadedAt]: manifest.uploadedAt,
    [MANIFEST_KEYS.algorithm]: manifest.algorithm,
    [MANIFEST_KEYS.sizeBytes]: String(manifest.sizeBytes),
  });

  const backups = [manifest, ...keep];
  return {
    backup: manifest,
    pruned: pruned.map((entry) => entry.id),
    quota: quotaOf(ctx, backups),
  };
}

export async function downloadBackup(
  ctx: CloudContext,
  caller: Caller,
  id: string,
): Promise<{ manifest: BackupManifest; ciphertext: Uint8Array }> {
  // The key is namespaced by the caller's own licence, so one account can never
  // address another's backup regardless of what id it supplies.
  const blob = await ctx.blobs.get(blobKey(caller.namespace, requireId(id)));
  if (!blob) {
    throw new AppError("NOT_FOUND", "That backup no longer exists.");
  }

  return {
    manifest: manifestFrom(id, blob.metadata, blob.bytes.byteLength),
    ciphertext: blob.bytes,
  };
}

export async function deleteBackup(
  ctx: CloudContext,
  caller: Caller,
  id: string,
): Promise<BackupList> {
  const key = blobKey(caller.namespace, requireId(id));
  if (!(await ctx.blobs.get(key))) {
    throw new AppError("NOT_FOUND", "That backup no longer exists.");
  }

  await ctx.blobs.delete(key);
  return listBackups(ctx, caller);
}

/** Newest first — retention and the UI both depend on this ordering. */
async function readManifests(
  ctx: CloudContext,
  caller: Caller,
): Promise<BackupManifest[]> {
  const prefix = `backups/${caller.namespace}/`;
  const entries = await ctx.blobs.list(prefix);

  return entries
    .map((entry) =>
      manifestFrom(
        entry.key.slice(prefix.length),
        entry.metadata,
        Number.parseInt(entry.metadata[MANIFEST_KEYS.sizeBytes] ?? "0", 10),
      ),
    )
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

function manifestFrom(
  id: string,
  metadata: Record<string, string>,
  sizeBytes: number,
): BackupManifest {
  return {
    id,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    createdAt: metadata[MANIFEST_KEYS.createdAt] ?? metadata[MANIFEST_KEYS.uploadedAt] ?? "",
    uploadedAt: metadata[MANIFEST_KEYS.uploadedAt] ?? "",
    algorithm: metadata[MANIFEST_KEYS.algorithm] ?? BACKUP_ALGORITHM,
  };
}

function quotaOf(ctx: CloudContext, backups: BackupManifest[]): BackupQuota {
  return {
    usedBytes: backups.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    limitBytes: ctx.config.quotaBytes,
    count: backups.length,
    maxCount: ctx.config.maxBackups,
    maxUploadBytes: ctx.config.maxUploadBytes,
  };
}

/** Ids are generated by us; anything with a path separator is an attack. */
function requireId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("..")) {
    throw new AppError("VALIDATION_FAILED", "That isn't a backup id.");
  }
  return trimmed;
}

function isoOr(value: string | null, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 1 : 0)}MB`;
}
