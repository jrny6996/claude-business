/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version`
 * pragma. Append-only: never edit a shipped migration, add a new one.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT,
        tier          TEXT NOT NULL DEFAULT 'free',
        premium_until TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Secrets are stored as opaque ciphertext produced by a SecretCipher.
      -- Plaintext never touches this table, and last4 is the only hint kept
      -- so the UI can answer "is this the key I think it is?".
      CREATE TABLE secrets (
        name              TEXT PRIMARY KEY,
        ciphertext        BLOB NOT NULL,
        last4             TEXT,
        updated_at        TEXT NOT NULL,
        last_validated_at TEXT
      );

      CREATE TABLE stores (
        id           TEXT PRIMARY KEY,
        config_json  TEXT NOT NULL,
        product_json TEXT NOT NULL,
        status       TEXT NOT NULL,
        output_dir   TEXT,
        deployed_url TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX idx_stores_created_at ON stores (created_at DESC);
    `,
  },
];

export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);
