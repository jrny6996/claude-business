import { Hono } from "hono";
import { z } from "zod";
import { DeployProviderSchema } from "@repo/shared";
import { SECRET_NAMES } from "@repo/db";
import type { AppContext } from "../context.js";
import {
  deleteSecret,
  getSettings,
  saveDeployToken,
  saveOpenRouterKey,
  saveStripeKey,
  setBackupPreferences,
} from "../services/settings.js";
import { respondWithError } from "./errors.js";

const KeyBody = z.object({ apiKey: z.string().min(1) });
const StripeBody = z.object({ secretKey: z.string().min(1) });
const DeployBody = z.object({
  provider: DeployProviderSchema,
  token: z.string().min(1),
});
const BackupBody = z.object({
  enabled: z.boolean(),
  directory: z.string().min(1).nullable().default(null),
});
const SecretParam = z.enum(SECRET_NAMES);

/**
 * Settings routes. Handlers stay thin — parse, delegate, serialise — with the
 * behaviour living in `services/settings.ts`.
 */
export function settingsRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ ok: true, value: getSettings(ctx) }));

  app.put("/openrouter-key", async (c) => {
    try {
      const body = KeyBody.parse(await c.req.json());
      return c.json({ ok: true, value: await saveOpenRouterKey(ctx, body.apiKey) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.put("/stripe-key", async (c) => {
    try {
      const body = StripeBody.parse(await c.req.json());
      return c.json({ ok: true, value: await saveStripeKey(ctx, body.secretKey) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.put("/deploy-token", async (c) => {
    try {
      const body = DeployBody.parse(await c.req.json());
      return c.json({
        ok: true,
        value: saveDeployToken(ctx, body.provider, body.token),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.delete("/secrets/:name", (c) => {
    try {
      const name = SecretParam.parse(c.req.param("name"));
      return c.json({ ok: true, value: deleteSecret(ctx, name) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.put("/backup", async (c) => {
    try {
      const body = BackupBody.parse(await c.req.json());
      return c.json({ ok: true, value: setBackupPreferences(ctx, body) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
