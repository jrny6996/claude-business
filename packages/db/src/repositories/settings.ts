import type { SecretMetadata } from "@repo/shared";
import type { Db } from "../client.js";
import { last4, type SecretCipher } from "../crypto.js";

/** Names of the secrets we hold. Anything not listed here has no home. */
export const SECRET_NAMES = [
  "openrouter_api_key",
  "gemini_api_key",
  "stripe_secret_key",
  "license_key",
  "device_token",
  "backup_encryption_key",
  "deploy_token_vercel",
  "deploy_token_netlify",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

interface SecretRow {
  ciphertext: Buffer;
  last4: string | null;
  updated_at: string;
  last_validated_at: string | null;
}

/**
 * Settings and secret storage.
 *
 * Secrets are encrypted before they reach SQLite and decrypted only at the
 * moment of use. `readSecret` is deliberately the only way to get plaintext
 * back out, so it is easy to audit every call site.
 */
export class SettingsRepository {
  readonly #db: Db;
  readonly #cipher: SecretCipher;

  constructor(db: Db, cipher: SecretCipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  get(key: string): string | null {
    const row = this.#db
      .prepare<[string], { value: string }>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get(key);
    return row?.value ?? null;
  }

  set(key: string, value: string, now = new Date().toISOString()): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  getBoolean(key: string, fallback = false): boolean {
    const raw = this.get(key);
    return raw === null ? fallback : raw === "true";
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? "true" : "false");
  }

  /** Encrypts and stores a secret, replacing any previous value. */
  writeSecret(
    name: SecretName,
    plaintext: string,
    now = new Date().toISOString(),
  ): void {
    const ciphertext = this.#cipher.encrypt(plaintext);
    this.#db
      .prepare(
        `INSERT INTO secrets (name, ciphertext, last4, updated_at, last_validated_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext,
                                         last4 = excluded.last4,
                                         updated_at = excluded.updated_at,
                                         last_validated_at = NULL`,
      )
      .run(name, ciphertext, last4(plaintext), now);
  }

  /**
   * Returns the decrypted secret, or null if unset.
   *
   * Every call site must send the value straight to the service it belongs to
   * and never log it, embed it in a generated store, or return it over IPC.
   */
  readSecret(name: SecretName): string | null {
    const row = this.#secretRow(name);
    if (!row) return null;
    return this.#cipher.decrypt(row.ciphertext);
  }

  /** Safe-to-display metadata about a secret. Contains no key material. */
  describeSecret(name: SecretName): SecretMetadata {
    const row = this.#secretRow(name);
    if (!row) {
      return {
        present: false,
        last4: null,
        updatedAt: null,
        lastValidatedAt: null,
      };
    }
    return {
      present: true,
      last4: row.last4,
      updatedAt: row.updated_at,
      lastValidatedAt: row.last_validated_at,
    };
  }

  markSecretValidated(name: SecretName, now = new Date().toISOString()): void {
    this.#db
      .prepare("UPDATE secrets SET last_validated_at = ? WHERE name = ?")
      .run(now, name);
  }

  deleteSecret(name: SecretName): void {
    this.#db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }

  #secretRow(name: SecretName): SecretRow | undefined {
    return this.#db
      .prepare<[string], SecretRow>(
        `SELECT ciphertext, last4, updated_at, last_validated_at
         FROM secrets WHERE name = ?`,
      )
      .get(name);
  }
}
