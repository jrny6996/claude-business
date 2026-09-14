import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  createStore,
  deleteStore,
  getStore,
  listStores,
  previewProduct,
  regenerateStore,
  rewriteStoreCopy,
  updateStoreTheme,
} from "../services/stores.js";
import { respondWithError } from "./errors.js";

const PreviewBody = z.object({ url: z.string().min(1) });

const CreateBody = z.object({
  url: z.string().min(1),
  config: z.unknown(),
  useAiCopy: z.boolean().default(false),
  useAiAltText: z.boolean().default(false),
  bundleAssets: z.boolean().default(true),
  enableCheckout: z.boolean().default(true),
});

const RegenerateBody = z.object({ config: z.unknown().optional() });
/** No `storeIds` means every store — the bulk action the Stores screen offers. */
const AiCopyBody = z.object({ storeIds: z.array(z.string()).optional() });
const ThemeBody = z.object({ theme: z.unknown() });

export function storeRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/preview", async (c) => {
    try {
      const body = PreviewBody.parse(await c.req.json());
      return c.json({ ok: true, value: await previewProduct(ctx, body) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.get("/", (c) => c.json({ ok: true, value: listStores(ctx) }));

  app.get("/:id", (c) => {
    try {
      return c.json({ ok: true, value: getStore(ctx, c.req.param("id")) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = CreateBody.parse(await c.req.json());
      return c.json({ ok: true, value: await createStore(ctx, body) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/ai-copy", async (c) => {
    try {
      const body = AiCopyBody.parse(await c.req.json().catch(() => ({})));
      return c.json({
        ok: true,
        value: await rewriteStoreCopy(ctx, body.storeIds),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/:id/regenerate", async (c) => {
    try {
      const body = RegenerateBody.parse(await c.req.json().catch(() => ({})));
      return c.json({
        ok: true,
        value: await regenerateStore(ctx, c.req.param("id"), body.config),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.put("/:id/theme", async (c) => {
    try {
      const body = ThemeBody.parse(await c.req.json());
      return c.json({
        ok: true,
        value: await updateStoreTheme(ctx, c.req.param("id"), body.theme),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.delete("/:id", (c) => {
    try {
      deleteStore(ctx, c.req.param("id"));
      return c.json({ ok: true, value: { deleted: true } });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
