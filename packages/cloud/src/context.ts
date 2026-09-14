import type { BlobStore } from "./storage/blobs.js";
import type { StripeApi } from "./services/stripe.js";
import type { Mailer } from "./services/mail.js";

/**
 * Everything the hosted service needs from its host.
 *
 * Built once by the deployment (`apps/landing`) and handed to `createCloudApp`,
 * exactly as the desktop app builds an `AppContext` for the local API. Keeping
 * it explicit is what lets the whole service be tested with an in-memory blob
 * store, a fake Stripe and a mailer that just records what it was asked to send.
 */
export interface CloudConfig {
  /** Stripe Price the checkout session is created against. */
  premiumPriceId: string;
  /** Where Stripe returns the buyer. */
  siteUrl: string;
  /**
   * Largest single upload accepted, in bytes.
   *
   * Must stay under the platform's own request-body limit — Netlify's synchronous
   * functions cap at 6MB, so the default here is deliberately below that. A
   * backup that exceeds it is refused with a message saying so, rather than
   * failing somewhere in the platform with no explanation.
   */
  maxUploadBytes: number;
  /** Total ciphertext one account may hold. */
  quotaBytes: number;
  /** Backups retained per account; older ones are pruned on upload. */
  maxBackups: number;
}

export const DEFAULT_CLOUD_CONFIG: Omit<
  CloudConfig,
  "premiumPriceId" | "siteUrl"
> = {
  maxUploadBytes: 5 * 1024 * 1024,
  quotaBytes: 250 * 1024 * 1024,
  maxBackups: 10,
};

export interface CloudContext {
  config: CloudConfig;
  blobs: BlobStore;
  stripe: StripeApi;
  mailer: Mailer;
  /** Shared secret Stripe signs webhooks with. */
  stripeWebhookSecret: string;
  /** Injected so tests are deterministic. */
  now?: () => Date;
}

export const nowOf = (ctx: CloudContext): Date =>
  ctx.now ? ctx.now() : new Date();
