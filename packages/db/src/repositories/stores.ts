import {
  NormalizedProductSchema,
  StoreConfigSchema,
  StoreStatusSchema,
  type NormalizedProduct,
  type Store,
  type StoreConfig,
  type StoreStatus,
} from "@repo/shared";
import type { Db } from "../client.js";

interface StoreRow {
  id: string;
  config_json: string;
  product_json: string;
  status: string;
  output_dir: string | null;
  deployed_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateStoreInput {
  id: string;
  config: StoreConfig;
  product: NormalizedProduct;
}

export interface UpdateStoreInput {
  config?: StoreConfig;
  status?: StoreStatus;
  outputDir?: string | null;
  deployedUrl?: string | null;
}

export class StoreRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: CreateStoreInput, now = new Date().toISOString()): Store {
    this.#db
      .prepare(
        `INSERT INTO stores
           (id, config_json, product_json, status, output_dir, deployed_url, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        JSON.stringify(input.config),
        JSON.stringify(input.product),
        now,
        now,
      );

    const created = this.findById(input.id);
    if (!created) throw new Error(`Store ${input.id} vanished after insert`);
    return created;
  }

  findById(id: string): Store | null {
    const row = this.#db
      .prepare<[string], StoreRow>("SELECT * FROM stores WHERE id = ?")
      .get(id);
    return row ? rowToStore(row) : null;
  }

  list(limit = 100): Store[] {
    return this.#db
      .prepare<[number], StoreRow>(
        "SELECT * FROM stores ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(rowToStore);
  }

  update(
    id: string,
    patch: UpdateStoreInput,
    now = new Date().toISOString(),
  ): Store | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const next = {
      config: patch.config ?? existing.config,
      status: patch.status ?? existing.status,
      outputDir:
        patch.outputDir !== undefined ? patch.outputDir : existing.outputDir,
      deployedUrl:
        patch.deployedUrl !== undefined
          ? patch.deployedUrl
          : existing.deployedUrl,
    };

    this.#db
      .prepare(
        `UPDATE stores
            SET config_json = ?, status = ?, output_dir = ?, deployed_url = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify(next.config),
        next.status,
        next.outputDir,
        next.deployedUrl,
        now,
        id,
      );

    return this.findById(id);
  }

  delete(id: string): boolean {
    return (
      this.#db.prepare("DELETE FROM stores WHERE id = ?").run(id).changes > 0
    );
  }

  count(): number {
    const row = this.#db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM stores")
      .get();
    return row?.n ?? 0;
  }
}

/**
 * Rows are re-validated on the way out. A store written by an older build (or
 * hand-edited) surfaces as a loud parse error here rather than as a subtly
 * broken storefront three steps later.
 */
function rowToStore(row: StoreRow): Store {
  return {
    id: row.id,
    config: StoreConfigSchema.parse(JSON.parse(row.config_json)),
    product: NormalizedProductSchema.parse(JSON.parse(row.product_json)),
    status: StoreStatusSchema.parse(row.status),
    outputDir: row.output_dir,
    deployedUrl: row.deployed_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
