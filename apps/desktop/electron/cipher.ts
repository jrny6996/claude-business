import { join } from "node:path";
import { app, safeStorage } from "electron";
import { localKeyCipher, type SecretCipher } from "@repo/db";

/** Wraps Electron's OS-keychain-backed encryption as a {@link SecretCipher}. */
class SafeStorageCipher implements SecretCipher {
  readonly isOsBacked = true;

  encrypt(plaintext: string): Buffer {
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    return safeStorage.decryptString(ciphertext);
  }
}

/**
 * Prefers the OS keychain and falls back to a local key file.
 *
 * On Linux `safeStorage` needs a running secret service (gnome-keyring, KWallet
 * or similar); plenty of the machines this app targets won't have one, and
 * refusing to start would be worse than the documented weaker fallback.
 */
export function createCipher(): { cipher: SecretCipher; osBacked: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { cipher: new SafeStorageCipher(), osBacked: true };
  }

  return {
    cipher: localKeyCipher(join(app.getPath("userData"), "secret.key")),
    osBacked: false,
  };
}
