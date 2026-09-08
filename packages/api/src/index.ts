import { Hono } from "hono";
import type { AppContext } from "./context.js";
import { deployRoutes } from "./routes/deploy.js";
import { respondWithError } from "./routes/errors.js";
import { healthRoutes } from "./routes/health.js";
import { licensingRoutes } from "./routes/licensing.js";
import { settingsRoutes } from "./routes/settings.js";
import { storeRoutes } from "./routes/stores.js";

export * from "./context.js";
export * from "./services/settings.js";
export * from "./services/stores.js";
export * from "./services/licensing.js";
export * from "./services/license-keys.js";
export * from "./services/deploy.js";
export * from "./services/backup.js";
export * from "./services/cloud-backup.js";
export { statusFor } from "./routes/errors.js";

/**
 * The local API, embedded in the Electron main process.
 *
 * It listens on loopback only and is not a public service. One file per
 * resource, thin handlers, logic in `services/`.
 */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.route("/api/health", healthRoutes(ctx));
  app.route("/api/settings", settingsRoutes(ctx));
  app.route("/api/stores", storeRoutes(ctx));
  app.route("/api/license", licensingRoutes(ctx));
  app.route("/api/deploy", deployRoutes(ctx));

  app.notFound((c) =>
    c.json({ ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint." } }, 404),
  );

  app.onError((cause, c) => respondWithError(c, cause));

  return app;
}
