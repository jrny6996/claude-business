import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { LATEST_VERSION, MIGRATIONS } from "./migrations.js";

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** Absolute path to the SQLite file, or `:memory:` for tests. */
  path: string;
  readonly?: boolean;
}

/**
 * Opens (creating if needed) the per-user SQLite file and brings it up to the
 * latest schema version. All database access in the app goes through this
 * package — no raw queries anywhere else.
 */
export function openDatabase({ path, readonly = false }: OpenDatabaseOptions): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { readonly });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (!readonly) migrate(db);

  return db;
}

/** Applies any migrations newer than the file's recorded `user_version`. */
export function migrate(db: Db): number {
  const current = Number(
    (db.pragma("user_version", { simple: true }) as number) ?? 0,
  );
  if (current >= LATEST_VERSION) return current;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    // Each migration is its own transaction so a failure leaves the file at
    // the last good version rather than half-applied.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
  }

  return LATEST_VERSION;
}
