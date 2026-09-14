import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./client.js";

/**
 * Premium backup.
 *
 * Deliberately writes to a directory the **user** chooses on their own machine
 * or their own synced cloud folder. We do not upload this anywhere: CLAUDE.md
 * leaves the hosted destination undecided, and defaulting to our own storage
 * would quietly make us pay for user data. If a hosted destination is ever
 * agreed, add it as an explicit opt-in alongside this, not as a replacement.
 */
export interface BackupOptions {
  /** Directory the user nominated. Created if absent. */
  destinationDir: string;
  /** Backups to retain; older ones are pruned. */
  keep?: number;
  now?: Date;
}

export interface BackupResult {
  path: string;
  bytes: number;
  createdAt: string;
}

export async function backupDatabase(
  db: Db,
  { destinationDir, keep = 7, now = new Date() }: BackupOptions,
): Promise<BackupResult> {
  mkdirSync(destinationDir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = join(destinationDir, `store-validator-${stamp}.sqlite`);

  // better-sqlite3's online backup copies a consistent snapshot even while the
  // app keeps writing, which a plain file copy under WAL would not.
  await db.backup(target);

  pruneOldBackups(destinationDir, keep);

  return {
    path: target,
    bytes: statSync(target).size,
    createdAt: now.toISOString(),
  };
}

const BACKUP_PATTERN = /^store-validator-.*\.sqlite$/;

export function pruneOldBackups(destinationDir: string, keep: number): string[] {
  if (keep <= 0) return [];

  let entries: string[];
  try {
    entries = readdirSync(destinationDir);
  } catch {
    return [];
  }

  const backups = entries
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const name of backups.slice(keep)) {
    try {
      rmSync(join(destinationDir, name));
      removed.push(name);
    } catch {
      // A locked or already-removed file shouldn't fail the backup itself.
    }
  }
  return removed;
}
