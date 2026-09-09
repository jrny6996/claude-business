import { UserProfileSchema, type Tier, type UserProfile } from "@repo/shared";
import type { Db } from "../client.js";

interface UserRow {
  id: string;
  email: string | null;
  tier: string;
  premium_until: string | null;
  created_at: string;
}

/** The desktop app is single-user; this id is the row it always reads. */
export const LOCAL_USER_ID = "local";

export class UserRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Returns the local profile, creating a free-tier one on first run. */
  ensureLocalUser(now = new Date().toISOString()): UserProfile {
    const existing = this.findById(LOCAL_USER_ID);
    if (existing) return existing;

    this.#db
      .prepare(
        `INSERT INTO users (id, email, tier, premium_until, created_at)
         VALUES (?, NULL, 'free', NULL, ?)`,
      )
      .run(LOCAL_USER_ID, now);

    const created = this.findById(LOCAL_USER_ID);
    if (!created) throw new Error("Failed to create local user");
    return created;
  }

  findById(id: string): UserProfile | null {
    const row = this.#db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
      .get(id);
    if (!row) return null;

    return UserProfileSchema.parse({
      id: row.id,
      email: row.email,
      tier: row.tier,
      premiumUntil: row.premium_until,
      createdAt: row.created_at,
    });
  }

  setEntitlement(
    id: string,
    tier: Tier,
    premiumUntil: string | null,
  ): UserProfile | null {
    this.#db
      .prepare("UPDATE users SET tier = ?, premium_until = ? WHERE id = ?")
      .run(tier, premiumUntil, id);
    return this.findById(id);
  }

  setEmail(id: string, email: string | null): UserProfile | null {
    this.#db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, id);
    return this.findById(id);
  }
}
