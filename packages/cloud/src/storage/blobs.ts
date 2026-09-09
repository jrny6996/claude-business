/**
 * Object storage, as the only thing the service needs from its host.
 *
 * Kept to four methods so the deployment-specific implementation (Netlify
 * Blobs, in `apps/landing`) stays small and the whole service can be tested
 * against {@link MemoryBlobStore} with no network and no cloud account. This is
 * the same shape as `PageSource` in the scraper: the host supplies the
 * capability, the logic doesn't know whose it is.
 */
export interface StoredBlob {
  key: string;
  bytes: Uint8Array;
  metadata: Record<string, string>;
}

export interface BlobEntry {
  key: string;
  metadata: Record<string, string>;
}

export interface BlobStore {
  put(
    key: string,
    bytes: Uint8Array,
    metadata: Record<string, string>,
  ): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  delete(key: string): Promise<void>;
  /** Entries whose key starts with `prefix`. Metadata only — no bodies. */
  list(prefix: string): Promise<BlobEntry[]>;
}

/** In-memory store. Used by every test in this package, and by `npm run dev`. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, StoredBlob>();

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: Record<string, string>,
  ): Promise<void> {
    // Copied, so a caller reusing its buffer can't mutate stored bytes.
    this.#blobs.set(key, { key, bytes: new Uint8Array(bytes), metadata });
  }

  async get(key: string): Promise<StoredBlob | null> {
    const blob = this.#blobs.get(key);
    return blob ? { ...blob, bytes: new Uint8Array(blob.bytes) } : null;
  }

  async delete(key: string): Promise<void> {
    this.#blobs.delete(key);
  }

  async list(prefix: string): Promise<BlobEntry[]> {
    return [...this.#blobs.values()]
      .filter((blob) => blob.key.startsWith(prefix))
      .map(({ key, metadata }) => ({ key, metadata }));
  }

  /** Test helper: total bytes held, across every account. */
  get totalBytes(): number {
    return [...this.#blobs.values()].reduce(
      (sum, blob) => sum + blob.bytes.byteLength,
      0,
    );
  }
}
