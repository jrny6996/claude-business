import { Hono } from "hono";
import { z } from "zod";
import { TierSchema } from "@repo/shared";
import type { AppContext } from "../context.js";
import { applyLicense, getLicenseStatus } from "../services/licensing.js";
import { respondWithError } from "./errors.js";

const LicenseBody = z.object({
  tier: TierSchema,
  expiresAt: z.string().nullable().default(null),
});

export function licensingRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ ok: true, value: getLicenseStatus(ctx) }));

  app.put("/", async (c) => {
    try {
      const body = LicenseBody.parse(await c.req.json());
      return c.json({ ok: true, value: applyLicense(ctx, body) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
