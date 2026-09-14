import { backupDatabase, type BackupResult } from "@repo/db";
import { AppError, type BackupUploadResult } from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";
import {
  BACKUP_DIR_KEY,
  BACKUP_ENABLED_KEY,
  backupDestination,
  requirePremium,
} from "./settings.js";
import { uploadCloudBackup } from "./cloud-backup.js";

/**
 * Runs a premium backup to wherever the user has chosen.
 *
 * `local` writes to a folder they nominated — their own disk, or a cloud folder
 * they already sync. `cloud` uploads an encrypted copy to our hosted service.
 * `both` does both, and is what most people should pick: a hosted copy is only
 * a backup if the local one can also fail.
 *
 * A failure in one destination does not cancel the other. Losing the local
 * write because the network was down would be absurd.
 */
export interface RunBackupResult {
  local: BackupResult | null;
  cloud: BackupUploadResult | null;
  /** Destinations that failed, and why. Surfaced rather than swallowed. */
  failures: { destination: "local" | "cloud"; message: string }[];
}

export async function runBackup(ctx: AppContext): Promise<RunBackupResult> {
  requirePremium(ctx, "Automated backups are a premium feature.");

  const destination = backupDestination(ctx);
  const result: RunBackupResult = { local: null, cloud: null, failures: [] };

  if (destination === "local" || destination === "both") {
    try {
      result.local = await runLocalBackup(ctx);
    } catch (cause) {
      if (destination === "local") throw cause;
      result.failures.push({ destination: "local", message: messageOf(cause) });
    }
  }

  if (destination === "cloud" || destination === "both") {
    try {
      result.cloud = await uploadCloudBackup(ctx);
    } catch (cause) {
      if (destination === "cloud") throw cause;
      result.failures.push({ destination: "cloud", message: messageOf(cause) });
    }
  }

  return result;
}

async function runLocalBackup(ctx: AppContext): Promise<BackupResult> {
  const directory = ctx.data.settings.get(BACKUP_DIR_KEY);
  if (!directory) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Choose a backup folder in Settings first.",
    );
  }

  return backupDatabase(ctx.data.db, {
    destinationDir: directory,
    now: nowOf(ctx),
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof AppError ? cause.message : "That backup failed.";
}

export function isBackupEnabled(ctx: AppContext): boolean {
  return ctx.data.settings.getBoolean(BACKUP_ENABLED_KEY);
}
