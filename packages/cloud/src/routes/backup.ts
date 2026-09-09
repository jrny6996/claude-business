import { Hono } from "hono";
import {
  BACKUP_ALGORITHM_HEADER,
  BACKUP_CREATED_AT_HEADER,
  AppError,
} from "@repo/shared";
import type { CloudContext } from "../context.js";
import { authenticate } from "../services/auth.js";
import {
  deleteBackup,
  downloadBackup,
  listBackups,
  uploadBackup,
} from "../services/backups.js";
import { respondWithError } from "./errors.js";

/**
 * Hosted backups for premium subscribers.
 *
 * The body is raw ciphertext, not JSON. Base64 in a JSON envelope would inflate
 * every upload by a third for no benefit, and this service has a hard body
 * limit imposed by the platform it runs on.
 *
 * Nothing here can read a backup. The desktop app encrypts before uploading
 * with a key that is never transmitted, so these handlers move opaque bytes
 * and record their length.
 */
export function backupRoutes(ctx: CloudContext): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const caller = authenticate(ctx, c.req.raw);
      return c.json({ ok: true, value: await listBackups(ctx, caller) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/", async (c) => {
    try {
      const caller = authenticate(ctx, c.req.raw);

      // Checked before reading the body, so an oversized upload is refused
      // without buffering it into the function's memory first.
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (
        Number.isFinite(declared) &&
        declared > ctx.config.maxUploadBytes
      ) {
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          `That backup is larger than the ${Math.round(ctx.config.maxUploadBytes / (1024 * 1024))}MB limit. Back up to a local folder instead.`,
        );
      }

      const ciphertext = new Uint8Array(await c.req.arrayBuffer());

      const result = await uploadBackup(ctx, caller, {
        ciphertext,
        createdAt: c.req.header(BACKUP_CREATED_AT_HEADER) ?? null,
        algorithm: c.req.header(BACKUP_ALGORITHM_HEADER) ?? null,
      });

      return c.json({ ok: true, value: result });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.get("/:id", async (c) => {
    try {
      const caller = authenticate(ctx, c.req.raw);
      const { manifest, ciphertext } = await downloadBackup(
        ctx,
        caller,
        c.req.param("id"),
      );

      return new Response(ciphertext as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(manifest.sizeBytes),
          [BACKUP_CREATED_AT_HEADER]: manifest.createdAt,
          [BACKUP_ALGORITHM_HEADER]: manifest.algorithm,
          // Never cached anywhere: it's someone's database, even encrypted.
          "Cache-Control": "no-store",
        },
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      const caller = authenticate(ctx, c.req.raw);
      return c.json({
        ok: true,
        value: await deleteBackup(ctx, caller, c.req.param("id")),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
