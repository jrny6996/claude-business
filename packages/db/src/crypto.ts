import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Encrypts secrets (OpenRouter API keys, deploy tokens) at rest on the user's
 * own machine.
 *
 * The app supplies the implementation: in Electron this is backed by the OS
 * keychain via `safeStorage`, so the key material never sits on disk in a form
 * we control. `LocalKeyCipher` below is the fallback for contexts without a
 * keychain (headless tests, Linux boxes with no secret service) and is weaker —
 * it protects against casual file inspection and backup leakage, not against
 * an attacker who already has read access to the user's home directory.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  /** Whether key material is held by the OS keychain rather than a local file. */
  readonly isOsBacked: boolean;
}

export class SecretDecryptionError extends Error {
  constructor(message = "Stored secret could not be decrypted.") {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

/** AES-256-GCM with a 32-byte key. Layout: `iv | authTag | ciphertext`. */
export class Aes256GcmCipher implements SecretCipher {
  readonly isOsBacked = false;
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
    }
    this.#key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new SecretDecryptionError();
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Wrong key or tampered payload — never leak the underlying detail.
      throw new SecretDecryptionError();
    }
  }
}

/**
 * Loads (or creates) a 32-byte key file with owner-only permissions and wraps
 * it in an {@link Aes256GcmCipher}.
 */
export function localKeyCipher(keyFilePath: string): Aes256GcmCipher {
  return new Aes256GcmCipher(loadOrCreateKey(keyFilePath));
}

function loadOrCreateKey(keyFilePath: string): Buffer {
  try {
    const existing = readFileSync(keyFilePath);
    if (existing.length === KEY_BYTES) return existing;
  } catch {
    // Falls through to key creation.
  }

  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(keyFilePath), { recursive: true });
  writeFileSync(keyFilePath, key, { mode: 0o600 });
  try {
    chmodSync(keyFilePath, 0o600);
  } catch {
    // Best effort — some filesystems (e.g. mounted Windows shares) refuse.
  }
  return key;
}

/** Constant-time comparison, for verifying a secret without leaking timing. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** The only hint about a secret we ever persist or show. */
export function last4(secret: string): string | null {
  const trimmed = secret.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : null;
}
