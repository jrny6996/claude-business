import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
} from "../services/licensing.js";
import { respondWithError } from "./errors.js";

const ActivateBody = z.object({ key: z.string().min(1) });

export function licensingRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ ok: true, value: getLicenseStatus(ctx) }));

  // Activation takes a signed key, never a bare tier: the client is not
  // trusted to say what it has paid for.
  app.post("/activate", async (c) => {
    try {
      const body = ActivateBody.parse(await c.req.json());
      return c.json({ ok: true, value: activateLicense(ctx, body.key) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.delete("/", (c) => c.json({ ok: true, value: deactivateLicense(ctx) }));

  return app;
}
