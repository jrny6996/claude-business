import type { Config, Context } from "@netlify/functions";
import {
  DEFAULT_CLOUD_CONFIG,
  LoggingMailer,
  MemoryBlobStore,
  ResendMailer,
  S3BlobStore,
  StripeClient,
  createCloudApp,
  type BlobStore,
  type CloudContext,
  type Mailer,
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
 * Backup storage: S3, or anything that speaks it.
 *
 * `S3_ENDPOINT` points this at Cloudflare R2, Backblaze B2 or MinIO instead of
 * AWS. Worth knowing which you pick, now that we pay for this: a backup service
 * is egress-heavy by definition, and R2 charges nothing for it.
 *
 * With nothing configured this falls back to an in-memory store, so
 * `netlify dev` runs with no cloud account and loses everything on restart —
 * correct for a development stand-in, and loud enough that nobody mistakes it
 * for durable.
 */
function blobStore(): BlobStore {
  const env = process.env;
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    console.warn(
      "[cloud] S3 is not configured; using an in-memory store. Backups will not persist.",
    );
    return new MemoryBlobStore();
  }

  return new S3BlobStore({
    bucket,
    // R2 and several others ignore the region but still require one to sign.
    region: env.S3_REGION || "auto",
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
    },
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_PREFIX ? { prefix: env.S3_PREFIX } : {}),
  });
}

function mailer(): Mailer {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LICENSE_FROM_EMAIL;
  if (!apiKey || !from) return new LoggingMailer();
  return new ResendMailer({ apiKey, from });
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
