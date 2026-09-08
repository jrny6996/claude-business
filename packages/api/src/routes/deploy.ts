import { Hono } from "hono";
import { z } from "zod";
import { DeployProviderSchema } from "@repo/shared";
import type { AppContext } from "../context.js";
import {
  getDeployInstructions,
  recordDeployment,
} from "../services/deploy.js";
import { runBackup } from "../services/backup.js";
import {
  deleteCloudBackup,
  listCloudBackups,
  recoveryKey,
  restoreCloudBackup,
  setRecoveryKey,
} from "../services/cloud-backup.js";
import { respondWithError } from "./errors.js";

const ProviderQuery = z.object({ provider: DeployProviderSchema });
const RecordBody = z.object({ deployedUrl: z.string().min(1) });
const RecoveryKeyBody = z.object({ key: z.string().min(1) });

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

  /**
   * The backup recovery key.
   *
   * Its own endpoint rather than a field on the settings payload, so the key is
   * only ever sent when the user explicitly asks to see it — not on every poll
   * of the settings screen.
   */
  app.get("/backup/recovery-key", (c) => {
    try {
      return c.json({ ok: true, value: { key: recoveryKey(ctx) } });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.put("/backup/recovery-key", async (c) => {
    try {
      const body = RecoveryKeyBody.parse(await c.req.json());
      setRecoveryKey(ctx, body.key);
      return c.json({ ok: true, value: { ok: true } });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.get("/backup/cloud", async (c) => {
    try {
      return c.json({ ok: true, value: await listCloudBackups(ctx) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.delete("/backup/cloud/:id", async (c) => {
    try {
      return c.json({
        ok: true,
        value: await deleteCloudBackup(ctx, c.req.param("id")),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/backup/cloud/:id/restore", async (c) => {
    try {
      return c.json({
        ok: true,
        value: await restoreCloudBackup(ctx, c.req.param("id")),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
