export { openDatabase, migrate, type Db, type OpenDatabaseOptions } from "./client.js";
export { MIGRATIONS, LATEST_VERSION, type Migration } from "./migrations.js";
export {
  Aes256GcmCipher,
  SecretDecryptionError,
  localKeyCipher,
  secretsMatch,
  last4,
  type SecretCipher,
} from "./crypto.js";
export {
  SettingsRepository,
  SECRET_NAMES,
  type SecretName,
} from "./repositories/settings.js";
export {
  StoreRepository,
  type CreateStoreInput,
  type UpdateStoreInput,
} from "./repositories/stores.js";
export { UserRepository, LOCAL_USER_ID } from "./repositories/users.js";
export {
  backupDatabase,
  pruneOldBackups,
  type BackupOptions,
  type BackupResult,
} from "./backup.js";
export {
  BACKUP_KEY_BYTES,
  BackupDecryptionError,
  decryptBackup,
  encryptBackup,
  formatBackupKey,
  generateBackupKey,
  parseBackupKey,
} from "./backup-crypto.js";

import { openDatabase, type Db } from "./client.js";
import type { SecretCipher } from "./crypto.js";
import { SettingsRepository } from "./repositories/settings.js";
import { StoreRepository } from "./repositories/stores.js";
import { UserRepository } from "./repositories/users.js";

export interface DataLayer {
  db: Db;
  settings: SettingsRepository;
  stores: StoreRepository;
  users: UserRepository;
  close(): void;
}

/** Opens the database and wires up every repository in one call. */
export function createDataLayer(path: string, cipher: SecretCipher): DataLayer {
  const db = openDatabase({ path });
  const users = new UserRepository(db);
  users.ensureLocalUser();

  return {
    db,
    settings: new SettingsRepository(db, cipher),
    stores: new StoreRepository(db),
    users,
    close: () => db.close(),
  };
}
