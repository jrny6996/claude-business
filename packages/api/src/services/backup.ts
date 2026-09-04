import { backupDatabase, type BackupResult } from "@repo/db";
import { AppError } from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";
import {
  BACKUP_DIR_KEY,
  BACKUP_ENABLED_KEY,
  requirePremium,
} from "./settings.js";

/**
 * Runs a premium backup to the directory the user nominated.
 *
 * The destination is always somewhere on the user's own machine (or a folder
 * they sync themselves). We do not host this — see the note in
 * `packages/db/src/backup.ts`.
 */
export async function runBackup(ctx: AppContext): Promise<BackupResult> {
  requirePremium(ctx, "Automated backups are a premium feature.");

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

export function isBackupEnabled(ctx: AppContext): boolean {
  return ctx.data.settings.getBoolean(BACKUP_ENABLED_KEY);
}
