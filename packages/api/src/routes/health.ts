import { Hono } from "hono";
import type { AppContext } from "../context.js";

export function healthRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      ok: true,
      value: {
        status: "ok",
        stores: ctx.data.stores.count(),
      },
    }),
  );

  return app;
}
