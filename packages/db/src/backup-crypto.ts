import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Encrypting a database backup before it leaves the machine.
 *
 * Hosted backup is a paid opt-in, which means we pay to store other people's
 * data. That is only a defensible thing to do if we cannot read it — so the
 * file is sealed here, on the user's machine, with a key the service never
 * receives. What we store is ciphertext and a length.
 *
 * Separate from `SecretCipher` in `crypto.ts` on purpose. That one seals short
 * strings with a key the OS keychain holds for us; this one seals a whole file
 * with a key **the user owns and can write down**, because a backup has to be
 * restorable on a machine whose keychain knows nothing about it. Reusing the
 * keychain-backed cipher would have made every cloud backup unrestorable on a
 * new laptop, which is the exact situation backups exist for.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const BACKUP_KEY_BYTES = 32;

/**
 * Magic + version, so a file's format is self-describing.
 *
 * A backup can be restored years after it was written, by a build that has
 * changed. Guessing at the layout then is not an option.
 */
const MAGIC = Buffer.from("DSVBAK01", "ascii");

export class BackupDecryptionError extends Error {
  constructor(message = "That backup couldn't be decrypted.") {
    super(message);
    this.name = "BackupDecryptionError";
  }
}

/** A fresh 256-bit backup key. Generated once per user, then kept. */
export function generateBackupKey(): Buffer {
  return randomBytes(BACKUP_KEY_BYTES);
}

/**
 * The user-facing form of a backup key.
 *
 * Base32-ish over an unambiguous alphabet — no `0`/`O`, no `1`/`I`/`l` — and
 * grouped, because this is a string people copy off a screen and type back in
 * on a different machine, possibly having written it on paper. Base64 would be
 * shorter and much easier to get wrong.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export function formatBackupKey(key: Buffer): string {
  let value = BigInt(`0x${key.toString("hex")}`);
  const base = BigInt(ALPHABET.length);
  const chars: string[] = [];

  while (value > 0n) {
    chars.push(ALPHABET[Number(value % base)] as string);
    value /= base;
  }
  // Leading zero bytes carry no digits; pad so the length is always the same
  // and a round-trip is exact.
  while (chars.length < 52) chars.push(ALPHABET[0] as string);

  const encoded = chars.reverse().join("");
  return (encoded.match(/.{1,6}/g) ?? []).join("-");
}

export function parseBackupKey(formatted: string): Buffer {
  // Only formatting is stripped — whitespace and the grouping dashes. Anything
  // else is reported rather than silently dropped: the excluded characters are
  // exactly the confusable ones (`0`/`O`, `1`/`I`/`L`), so a mistyped key that
  // quietly parsed would decode to a *different* valid-looking key and fail
  // later as "couldn't be decrypted", sending the user hunting for the wrong
  // problem.
  const cleaned = formatted.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length === 0) {
    throw new BackupDecryptionError("That recovery key is empty.");
  }

  const base = BigInt(ALPHABET.length);
  let value = 0n;

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new BackupDecryptionError(
        `That recovery key contains "${char}", which isn't part of a recovery key. Recovery keys never contain 0, O, 1, I or L — check for a mistyped character.`,
      );
    }
    value = value * base + BigInt(index);
  }

  const hex = value.toString(16).padStart(BACKUP_KEY_BYTES * 2, "0");
  if (hex.length > BACKUP_KEY_BYTES * 2) {
    throw new BackupDecryptionError("That recovery key is too long.");
  }

  return Buffer.from(hex, "hex");
}

/** Seals a backup file. Layout: `magic | iv | authTag | ciphertext`. */
export function encryptBackup(plaintext: Buffer, key: Buffer): Buffer {
  requireKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Opens a sealed backup.
 *
 * Every failure is the same error on purpose: a wrong key, a truncated file
 * and a tampered one are not usefully distinguishable to the user, and GCM's
 * authentication failing is the only signal that matters.
 */
export function decryptBackup(sealed: Buffer, key: Buffer): Buffer {
  requireKey(key);

  const header = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length < header) {
    throw new BackupDecryptionError("That backup file is incomplete.");
  }

  const magic = sealed.subarray(0, MAGIC.length);
  if (magic.length !== MAGIC.length || !timingSafeEqual(magic, MAGIC)) {
    throw new BackupDecryptionError(
      "That file isn't a Store Validator backup, or was written by a newer version.",
    );
  }

  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, header);
  const ciphertext = sealed.subarray(header);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupDecryptionError(
      "That backup couldn't be decrypted. Check you're using the right recovery key.",
    );
  }
}

function requireKey(key: Buffer): void {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupDecryptionError(
      `A backup key must be ${BACKUP_KEY_BYTES} bytes.`,
    );
  }
}
