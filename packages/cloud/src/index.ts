import { Hono } from "hono";
import type { CloudContext } from "./context.js";
import { accountRoutes } from "./routes/account.js";
import { backupRoutes } from "./routes/backup.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { respondWithError } from "./routes/errors.js";
import { licenseRoutes } from "./routes/license.js";
import { webhookRoutes } from "./routes/webhook.js";

export * from "./context.js";
export * from "./storage/blobs.js";
export * from "./storage/s3.js";
export * from "./storage/sigv4.js";
export * from "./services/stripe.js";
export * from "./services/mail.js";
export * from "./services/issuer.js";
export * from "./services/auth.js";
export * from "./services/accounts.js";
export * from "./services/entitlement.js";
export * from "./services/backups.js";
export * from "./services/webhook-signature.js";
export { statusFor } from "./routes/errors.js";

/**
 * The hosted service: licence issuance and premium cloud backup.
 *
 * Deployed alongside the marketing site (`apps/landing`) rather than as its
 * own app — it is a handful of routes, it shares that site's domain, and the
 * purchase flow lives on both sides of the boundary anyway.
 *
 * This is the **only** part of the system that runs on our infrastructure and
 * costs us money, and it is deliberately small:
 *
 * - It never touches storefront traffic, AI inference, or a user's Stripe key.
 * - It holds the licence signing key, which exists nowhere else.
 * - It stores backups it cannot read, because the desktop app encrypts them
 *   first with a key we never receive.
 *
 * A Hono app rather than a set of Astro endpoints, for the same reason the
 * desktop app embeds one: the whole service can then be exercised through
 * `app.fetch(new Request(...))` with no platform in the picture, and the Astro
 * route that mounts it is four lines.
 */
export function createCloudApp(ctx: CloudContext): Hono {
  const app = new Hono();

  app.route("/api/account", accountRoutes(ctx));
  app.route("/api/checkout", checkoutRoutes(ctx));
  app.route("/api/license", licenseRoutes(ctx));
  app.route("/api/backup", backupRoutes(ctx));
  app.route("/api/stripe/webhook", webhookRoutes(ctx));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      value: {
        status: "ok",
        // Enough to tell a misconfigured deployment from a working one,
        // without disclosing any of the values.
        configured: {
          stripe: Boolean(ctx.config.premiumPriceId),
          webhook: Boolean(ctx.stripeWebhookSecret),
          issuer: Boolean(ctx.licensePrivateKeyPem),
        },
      },
    }),
  );

  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint." } },
      404,
    ),
  );

  app.onError((cause, c) => respondWithError(c, cause));

  return app;
}
