import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import {
  DEFAULT_CLOUD_CONFIG,
  LoggingMailer,
  MemoryBlobStore,
  ResendMailer,
  StripeClient,
  createCloudApp,
  type BlobEntry,
  type BlobStore,
  type CloudContext,
  type Mailer,
  type StoredBlob,
} from "@repo/cloud";
import type { Hono } from "hono";

/**
 * The entire server side of this product, in one function.
 *
 * Netlify Functions v2 hand you a `Request` and take a `Response`, which is
 * exactly `Hono.fetch` — so the handler below is a mount point and nothing
 * else. Routing, validation and error handling live in `@repo/cloud`, which is
 * tested end to end with no platform in the picture. The desktop app mounts its
 * own Hono app the same way.
 *
 * Everything else on this domain is a prerendered static file. This function is
 * the only part of the product that runs on our infrastructure and costs us
 * money, which is why it is worth keeping it visibly this small.
 *
 * The deployment-specific pieces — Netlify Blobs, and reading secrets out of
 * the environment — live here rather than in `@repo/cloud`, so that package
 * stays host-agnostic and testable. Same split as the Electron `PageSource` in
 * the desktop app.
 */

/**
 * Netlify Blobs behind the service's own storage interface.
 *
 * Strong consistency is deliberate: the default is eventually consistent, and a
 * user who takes a backup then opens the list would otherwise be told it isn't
 * there.
 */
class NetlifyBlobStore implements BlobStore {
  readonly #store = getStore({ name: "dsv-backups", consistency: "strong" });

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.#store.set(key, bytes as unknown as ArrayBuffer, { metadata });
  }

  async get(key: string): Promise<StoredBlob | null> {
    const result = await this.#store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) return null;

    return {
      key,
      bytes: new Uint8Array(result.data as ArrayBuffer),
      metadata: (result.metadata ?? {}) as Record<string, string>,
    };
  }

  async delete(key: string): Promise<void> {
    await this.#store.delete(key);
  }

  /**
   * Netlify's `list` returns keys without metadata, so each needs a follow-up
   * read. That is N requests, acceptable only because retention caps N at ten
   * per account — if that limit grows a lot, this wants an index blob instead.
   */
  async list(prefix: string): Promise<BlobEntry[]> {
    const { blobs } = await this.#store.list({ prefix });

    return Promise.all(
      blobs.map(async ({ key }) => {
        const metadata = await this.#store.getMetadata(key);
        return {
          key,
          metadata: (metadata?.metadata ?? {}) as Record<string, string>,
        };
      }),
    );
  }
}

/**
 * Netlify Blobs in production; an in-memory store when running locally.
 *
 * The fallback means `netlify dev` works with no blob store configured, and
 * loses everything on restart — correct for a development stand-in, and loud
 * enough that nobody mistakes it for durable.
 */
function blobStore(): BlobStore {
  try {
    return new NetlifyBlobStore();
  } catch {
    console.warn(
      "[cloud] Netlify Blobs unavailable; using an in-memory store. Backups will not persist.",
    );
    return new MemoryBlobStore();
  }
}

function mailer(): Mailer {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LICENSE_FROM_EMAIL;
  if (!apiKey || !from) return new LoggingMailer();
  return new ResendMailer({ apiKey, from });
}

/**
 * Environment variables can't hold real newlines on most hosts, so a PEM is
 * pasted with `\n` escapes. Restoring them is the difference between a working
 * issuer and an opaque "unsupported key" error at signing time.
 */
function pem(value: string | undefined): string {
  return (value ?? "").replace(/\\n/g, "\n").trim();
}

function intFrom(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildContext(): CloudContext {
  const env = process.env;

  return {
    config: {
      ...DEFAULT_CLOUD_CONFIG,
      premiumPriceId: env.PREMIUM_PRICE_ID ?? "",
      siteUrl: (env.SITE_URL ?? env.URL ?? "http://localhost:8888").replace(/\/$/, ""),
      maxUploadBytes: intFrom(
        env.BACKUP_MAX_UPLOAD_BYTES,
        DEFAULT_CLOUD_CONFIG.maxUploadBytes,
      ),
      quotaBytes: intFrom(env.BACKUP_QUOTA_BYTES, DEFAULT_CLOUD_CONFIG.quotaBytes),
      maxBackups: intFrom(env.BACKUP_MAX_COUNT, DEFAULT_CLOUD_CONFIG.maxBackups),
    },
    blobs: blobStore(),
    // A missing key must not throw at module load — that would take every
    // route down, including the health check that would tell you why.
    stripe: new StripeClient({
      secretKey: env.STRIPE_SECRET_KEY || "not-configured",
    }),
    mailer: mailer(),
    licensePrivateKeyPem: pem(env.DSV_LICENSE_PRIVATE_KEY),
    licensePublicKeyPem: pem(env.DSV_LICENSE_PUBLIC_KEY),
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
  };
}

let app: Hono | undefined;

export default async function handler(
  request: Request,
  _context: Context,
): Promise<Response> {
  app ??= createCloudApp(buildContext());
  return app.fetch(request);
}

/** Claims `/api/*` directly, so the site needs no redirect rule. */
export const config: Config = {
  path: "/api/*",
};
