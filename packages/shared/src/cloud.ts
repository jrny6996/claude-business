import { z } from "zod";

/**
 * The contract between the desktop app and the hosted licensing/backup service.
 *
 * Two things this service does, and one it deliberately cannot:
 *
 * - It **issues** licences, driven by a Stripe subscription webhook. Signing is
 *   the one privileged operation in the whole system.
 * - It **stores** premium users' database backups, as an opt-in *alongside* the
 *   local-folder destination — never as a replacement.
 * - It **cannot read those backups.** The desktop app encrypts before upload
 *   with a key the service never receives, so what is stored is ciphertext and
 *   a length. That is what makes paying for this storage defensible rather than
 *   a liability: a breach of it leaks nothing.
 */

/** The credential for every authenticated cloud call is the licence key. */
export const CLOUD_AUTH_SCHEME = "Bearer";

/**
 * How the desktop app encrypts a backup before uploading it.
 *
 * Recorded per-backup rather than assumed, so a future format change stays
 * detectable and old backups stay restorable.
 */
export const BACKUP_ALGORITHM = "AES-256-GCM";

export const BackupManifestSchema = z.object({
  id: z.string().min(1),
  /** Size of the *ciphertext*. The plaintext size is not something we know. */
  sizeBytes: z.number().int().nonnegative(),
  /** When the desktop app made the snapshot, by its own clock. */
  createdAt: z.iso.datetime(),
  /** When the service received it, by ours. Authoritative for retention. */
  uploadedAt: z.iso.datetime(),
  algorithm: z.string().min(1).default(BACKUP_ALGORITHM),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const BackupQuotaSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  /** Oldest backups past this are pruned on the next upload. */
  maxCount: z.number().int().positive(),
  maxUploadBytes: z.number().int().positive(),
});
export type BackupQuota = z.infer<typeof BackupQuotaSchema>;

export const BackupListSchema = z.object({
  backups: z.array(BackupManifestSchema),
  quota: BackupQuotaSchema,
});
export type BackupList = z.infer<typeof BackupListSchema>;

export const BackupUploadResultSchema = z.object({
  backup: BackupManifestSchema,
  /** Ids removed by retention pruning during this upload. */
  pruned: z.array(z.string()).default([]),
  quota: BackupQuotaSchema,
});
export type BackupUploadResult = z.infer<typeof BackupUploadResultSchema>;

/** Headers the upload carries. The body is raw ciphertext, not JSON. */
export const BACKUP_CREATED_AT_HEADER = "x-dsv-backup-created-at";
export const BACKUP_ALGORITHM_HEADER = "x-dsv-backup-algorithm";

/**
 * Where premium backups go.
 *
 * `local` is the original decision and remains the default: a folder the user
 * picks, on their own disk or in a cloud folder they already sync. `cloud` was
 * added later as an explicit paid opt-in. `both` is the belt-and-braces option
 * and is what most people should choose — a hosted copy is only a backup if the
 * local one can also fail.
 */
export const BackupDestinationSchema = z.enum(["local", "cloud", "both"]);
export type BackupDestination = z.infer<typeof BackupDestinationSchema>;
