import { Hono } from "hono";
import { z } from "zod";
import { DeployProviderSchema } from "@repo/shared";
import type { AppContext } from "../context.js";
import {
  getDeployInstructions,
  recordDeployment,
} from "../services/deploy.js";
import { runBackup } from "../services/backup.js";
import { respondWithError } from "./errors.js";

const ProviderQuery = z.object({ provider: DeployProviderSchema });
const RecordBody = z.object({ deployedUrl: z.string().min(1) });

export function deployRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/:id/instructions", (c) => {
    try {
      const { provider } = ProviderQuery.parse({
        provider: c.req.query("provider"),
      });
      return c.json({
        ok: true,
        value: getDeployInstructions(ctx, c.req.param("id"), provider),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/:id/deployed", async (c) => {
    try {
      const body = RecordBody.parse(await c.req.json());
      return c.json({
        ok: true,
        value: recordDeployment(ctx, c.req.param("id"), body.deployedUrl),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/backup", async (c) => {
    try {
      return c.json({ ok: true, value: await runBackup(ctx) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
