import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedProduct, StoreConfig } from "@repo/shared";
import { StoreConfigSchema } from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, pruneOldBackups } from "./backup.js";
import { migrate, openDatabase, type Db } from "./client.js";
import { Aes256GcmCipher, SecretDecryptionError, last4 } from "./crypto.js";
import { LATEST_VERSION } from "./migrations.js";
import { SettingsRepository } from "./repositories/settings.js";
import { StoreRepository } from "./repositories/stores.js";
import { UserRepository } from "./repositories/users.js";

const cipher = () => new Aes256GcmCipher(randomBytes(32));

const product: NormalizedProduct = {
  sourceId: "1005006",
  sourceUrl: "https://www.aliexpress.com/item/1005006.html",
  title: "Widget",
  description: "A widget.",
  highlights: [],
  price: { amountCents: 1000, currency: "USD" },
  compareAtPrice: null,
  images: [],
  variants: [],
  ratingAverage: null,
  ratingCount: null,
  shipsFrom: null,
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

const config: StoreConfig = StoreConfigSchema.parse({ storeName: "Widgets" });

describe("migrations", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
  });
  afterEach(() => db.close());

  it("brings a fresh database to the latest version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("is idempotent", () => {
    expect(migrate(db)).toBe(LATEST_VERSION);
    expect(migrate(db)).toBe(LATEST_VERSION);
  });
});

describe("Aes256GcmCipher", () => {
  it("round-trips a secret", () => {
    const c = cipher();
    const secret = "sk-or-v1-abcdef123456";
    expect(c.decrypt(c.encrypt(secret))).toBe(secret);
  });

  it("does not store the plaintext in the ciphertext", () => {
    const c = cipher();
    const payload = c.encrypt("sk-or-v1-supersecret");
    expect(payload.toString("utf8")).not.toContain("supersecret");
  });

  it("rejects a payload encrypted under a different key", () => {
    const payload = cipher().encrypt("sk-or-v1-abc");
    expect(() => cipher().decrypt(payload)).toThrow(SecretDecryptionError);
  });

  it("rejects a tampered payload", () => {
    const c = cipher();
    const payload = c.encrypt("sk-or-v1-abc");
    payload[payload.length - 1] ^= 0xff;
    expect(() => c.decrypt(payload)).toThrow(SecretDecryptionError);
  });

  it("rejects a truncated payload", () => {
    const c = cipher();
    expect(() => c.decrypt(Buffer.alloc(4))).toThrow(SecretDecryptionError);
  });
});

describe("last4", () => {
  it("keeps only the trailing four characters", () => {
    expect(last4("sk-or-v1-abcd1234")).toBe("1234");
  });

  it("returns null for a value too short to hint at", () => {
    expect(last4("ab")).toBeNull();
  });
});

describe("SettingsRepository", () => {
  let db: Db;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    settings = new SettingsRepository(db, cipher());
  });
  afterEach(() => db.close());

  it("upserts plain settings", () => {
    settings.set("theme", "dark");
    settings.set("theme", "light");
    expect(settings.get("theme")).toBe("light");
  });

  it("returns null for an unknown key", () => {
    expect(settings.get("nope")).toBeNull();
  });

  it("round-trips booleans", () => {
    settings.setBoolean("backup", true);
    expect(settings.getBoolean("backup")).toBe(true);
    expect(settings.getBoolean("missing", true)).toBe(true);
  });

  it("stores secrets as ciphertext, never plaintext", () => {
    settings.writeSecret("openrouter_api_key", "sk-or-v1-plaintext9999");

    const raw = db
      .prepare("SELECT ciphertext FROM secrets WHERE name = ?")
      .get("openrouter_api_key") as { ciphertext: Buffer };
    expect(raw.ciphertext.toString("utf8")).not.toContain("plaintext");
    expect(settings.readSecret("openrouter_api_key")).toBe(
      "sk-or-v1-plaintext9999",
    );
  });

  it("describes a secret without exposing it", () => {
    settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");
    const meta = settings.describeSecret("openrouter_api_key");
    expect(meta).toMatchObject({ present: true, last4: "1234" });
    expect(JSON.stringify(meta)).not.toContain("sk-or-v1");
  });

  it("reports an absent secret", () => {
    expect(settings.describeSecret("deploy_token_vercel")).toMatchObject({
      present: false,
      last4: null,
    });
    expect(settings.readSecret("deploy_token_vercel")).toBeNull();
  });

  it("clears the validation stamp when a secret is replaced", () => {
    settings.writeSecret("openrouter_api_key", "sk-or-v1-one1");
    settings.markSecretValidated("openrouter_api_key");
    expect(
      settings.describeSecret("openrouter_api_key").lastValidatedAt,
    ).not.toBeNull();

    settings.writeSecret("openrouter_api_key", "sk-or-v1-two2");
    expect(
      settings.describeSecret("openrouter_api_key").lastValidatedAt,
    ).toBeNull();
  });

  it("deletes a secret", () => {
    settings.writeSecret("deploy_token_netlify", "nfp_abcd1234");
    settings.deleteSecret("deploy_token_netlify");
    expect(settings.describeSecret("deploy_token_netlify").present).toBe(false);
  });
});

describe("StoreRepository", () => {
  let db: Db;
  let stores: StoreRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    stores = new StoreRepository(db);
  });
  afterEach(() => db.close());

  it("creates a store in draft status", () => {
    const store = stores.create({ id: "s1", config, product });
    expect(store.status).toBe("draft");
    expect(store.product.title).toBe("Widget");
    expect(store.outputDir).toBeNull();
  });

  it("round-trips config and product through JSON columns", () => {
    stores.create({ id: "s1", config, product });
    const found = stores.findById("s1");
    expect(found?.config).toEqual(config);
    expect(found?.product).toEqual(product);
  });

  it("patches only the provided fields", () => {
    stores.create({ id: "s1", config, product });
    const updated = stores.update("s1", {
      status: "generated",
      outputDir: "/tmp/s1",
    });
    expect(updated?.status).toBe("generated");
    expect(updated?.outputDir).toBe("/tmp/s1");
    expect(updated?.config).toEqual(config);
    expect(updated?.deployedUrl).toBeNull();
  });

  it("distinguishes clearing a field from leaving it alone", () => {
    stores.create({ id: "s1", config, product });
    stores.update("s1", { deployedUrl: "https://example.com" });
    expect(stores.update("s1", { status: "deployed" })?.deployedUrl).toBe(
      "https://example.com",
    );
    expect(stores.update("s1", { deployedUrl: null })?.deployedUrl).toBeNull();
  });

  it("returns null when updating a store that does not exist", () => {
    expect(stores.update("ghost", { status: "failed" })).toBeNull();
  });

  it("lists newest first", () => {
    stores.create({ id: "old", config, product }, "2026-01-01T00:00:00.000Z");
    stores.create({ id: "new", config, product }, "2026-02-01T00:00:00.000Z");
    expect(stores.list().map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("deletes and counts", () => {
    stores.create({ id: "s1", config, product });
    expect(stores.count()).toBe(1);
    expect(stores.delete("s1")).toBe(true);
    expect(stores.delete("s1")).toBe(false);
    expect(stores.count()).toBe(0);
  });
});

describe("UserRepository", () => {
  let db: Db;
  let users: UserRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    users = new UserRepository(db);
  });
  afterEach(() => db.close());

  it("creates a free-tier local user on first run and reuses it after", () => {
    const first = users.ensureLocalUser();
    expect(first.tier).toBe("free");
    expect(users.ensureLocalUser().createdAt).toBe(first.createdAt);
  });

  it("records a premium entitlement", () => {
    users.ensureLocalUser();
    const updated = users.setEntitlement(
      "local",
      "premium",
      "2027-01-01T00:00:00.000Z",
    );
    expect(updated?.tier).toBe("premium");
    expect(updated?.premiumUntil).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("backupDatabase", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsv-backup-"));
    db = openDatabase({ path: join(dir, "app.sqlite") });
    new StoreRepository(db).create({ id: "s1", config, product });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a readable snapshot to the user's chosen directory", async () => {
    const dest = join(dir, "backups");
    const result = await backupDatabase(db, { destinationDir: dest });

    expect(result.bytes).toBeGreaterThan(0);
    const restored = openDatabase({ path: result.path, readonly: true });
    expect(new StoreRepository(restored).count()).toBe(1);
    restored.close();
  });

  it("prunes older backups beyond the retention limit", async () => {
    const dest = join(dir, "backups");
    for (let i = 0; i < 4; i++) {
      await backupDatabase(db, {
        destinationDir: dest,
        keep: 2,
        now: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dest)).toHaveLength(2);
  });

  it("ignores a missing directory when pruning", () => {
    expect(pruneOldBackups(join(dir, "does-not-exist"), 3)).toEqual([]);
  });
});
