import { AppError } from "@repo/shared";
import { sha256Hex, signRequest, type SigV4Credentials } from "./sigv4.js";
import type { BlobEntry, BlobStore, StoredBlob } from "./blobs.js";

/**
 * S3 (or anything that speaks S3) as the backup store.
 *
 * Lives in `packages/cloud` rather than in the deploy wiring, unlike the
 * host-specific stores: S3 is not tied to a platform, it is substantial enough
 * to deserve its own tests, and pointing `endpoint` elsewhere makes Cloudflare
 * R2, Backblaze B2 or MinIO work unchanged. Worth having now that we pay for
 * this storage — R2 charges nothing for egress, which a service whose whole
 * job is handing files back feels directly.
 *
 * What is stored is ciphertext the desktop app sealed before upload. This class
 * moves opaque bytes; it has no key and no way to read one.
 */
export interface S3Config {
  bucket: string;
  region: string;
  credentials: SigV4Credentials;
  /**
   * Base URL of an S3-compatible endpoint, e.g.
   * `https://<account>.r2.cloudflarestorage.com`. Omit for AWS, which is
   * addressed virtual-hosted style.
   */
  endpoint?: string;
  /** Prefix every key, so one bucket can hold more than this service. */
  prefix?: string;
  /** Injected in tests. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Metadata travels as one base64 header rather than one per field.
 *
 * S3 lowercases user metadata keys, which would silently turn `createdAt` into
 * `createdat` and break every read — and its values must be US-ASCII. One
 * base64'd JSON blob sidesteps both, and keeps the round trip exact whatever
 * the service decides to record later.
 */
const MANIFEST_HEADER = "x-amz-meta-manifest";

export class S3BlobStore implements BlobStore {
  readonly #config: S3Config;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: S3Config) {
    if (!config.bucket) {
      throw new AppError(
        "CLOUD_REQUEST_FAILED",
        "Backup storage isn't configured.",
        "S3_BUCKET is not set",
      );
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? (globalThis.fetch as typeof globalThis.fetch);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.#send("PUT", this.#objectUrl(key), bytes, {
      "Content-Type": "application/octet-stream",
      [MANIFEST_HEADER]: encodeManifest(metadata),
    });
  }

  async get(key: string): Promise<StoredBlob | null> {
    const response = await this.#send("GET", this.#objectUrl(key), undefined, {}, [
      404,
    ]);
    if (response.status === 404) return null;

    return {
      key,
      bytes: new Uint8Array(await response.arrayBuffer()),
      metadata: decodeManifest(response.headers.get(MANIFEST_HEADER)),
    };
  }

  async delete(key: string): Promise<void> {
    // S3 returns 204 for a key that never existed, which matches the
    // interface's "delete is idempotent" expectation.
    await this.#send("DELETE", this.#objectUrl(key), undefined, {}, [404]);
  }

  /**
   * Keys under a prefix, with their metadata.
   *
   * `ListObjectsV2` does not return user metadata, so each key needs a HEAD.
   * That is N requests, acceptable only because retention caps N at ten per
   * account — if that limit grows a lot, this wants an index object instead.
   */
  async list(prefix: string): Promise<BlobEntry[]> {
    const keys = await this.#listKeys(prefix);

    return Promise.all(
      keys.map(async (key) => {
        const head = await this.#send("HEAD", this.#objectUrl(key), undefined, {}, [
          404,
        ]);
        return {
          key,
          metadata:
            head.status === 404
              ? {}
              : decodeManifest(head.headers.get(MANIFEST_HEADER)),
        };
      }),
    );
  }

  async #listKeys(prefix: string): Promise<string[]> {
    const full = `${this.#config.prefix ?? ""}${prefix}`;
    const keys: string[] = [];
    let token: string | undefined;

    // Paginated properly even though retention makes truncation unlikely: a
    // silently truncated list would under-report usage and defeat the quota.
    do {
      const url = new URL(this.#bucketUrl());
      url.searchParams.set("list-type", "2");
      if (full) url.searchParams.set("prefix", full);
      if (token) url.searchParams.set("continuation-token", token);

      const response = await this.#send("GET", url.toString());
      const xml = await response.text();

      for (const key of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        keys.push(unescapeXml(key[1] ?? ""));
      }

      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unescapeXml(
            /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ??
              "",
          ) || undefined
        : undefined;
    } while (token);

    // Keys come back prefixed; callers deal in the unprefixed form.
    const strip = this.#config.prefix ?? "";
    return keys.map((key) => (strip && key.startsWith(strip) ? key.slice(strip.length) : key));
  }

  #bucketUrl(): string {
    const { bucket, region, endpoint } = this.#config;
    if (endpoint) return `${endpoint.replace(/\/$/, "")}/${encodeURIComponent(bucket)}`;
    // AWS virtual-hosted style. Path style is deprecated there.
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  #objectUrl(key: string): string {
    const full = `${this.#config.prefix ?? ""}${key}`;
    // Each segment encoded, separators preserved — must match what the signer
    // canonicalises, or every request with an escapable character fails.
    const path = full
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.#bucketUrl()}/${path}`;
  }

  async #send(
    method: string,
    url: string,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    tolerate: number[] = [],
  ): Promise<Response> {
    const payloadHash = sha256Hex(body ?? new Uint8Array());

    const signed = signRequest({
      method,
      url,
      headers: { ...headers, "x-amz-content-sha256": payloadHash },
      ...(body === undefined ? {} : { body }),
      region: this.#config.region,
      service: "s3",
      credentials: this.#config.credentials,
      ...(this.#config.now ? { now: this.#config.now() } : {}),
    });

    let response: Response;
    try {
      response = await this.#fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
      });
    } catch {
      throw new AppError(
        "CLOUD_REQUEST_FAILED",
        "Couldn't reach backup storage. Try again in a moment.",
      );
    }

    if (!response.ok && !tolerate.includes(response.status)) {
      // S3's error body is XML naming the bucket and key. Neither is secret,
      // but neither helps a user either, so only the code is surfaced.
      throw new AppError(
        "CLOUD_REQUEST_FAILED",
        "Backup storage rejected that request.",
        `HTTP ${response.status}`,
      );
    }

    return response;
  }
}

function encodeManifest(metadata: Record<string, string>): string {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
}

function decodeManifest(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    // A manifest we can't read shouldn't hide the object it belongs to.
    return {};
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
