import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  getAccountState,
  refreshEntitlement,
  requestSigninCode,
  signOut,
  verifySigninCode,
} from "../services/account.js";
import { respondWithError } from "./errors.js";

const EmailBody = z.object({ email: z.string().min(1) });
const VerifyBody = z.object({
  email: z.string().min(1),
  code: z.string().min(1),
});

/** Signing in, and keeping the subscription status current. */
export function accountRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ ok: true, value: getAccountState(ctx) }));

  app.post("/signin", async (c) => {
    try {
      const body = EmailBody.parse(await c.req.json());
      return c.json({ ok: true, value: await requestSigninCode(ctx, body.email) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/verify", async (c) => {
    try {
      const body = VerifyBody.parse(await c.req.json());
      return c.json({
        ok: true,
        value: await verifySigninCode(ctx, body.email, body.code),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/refresh", async (c) => {
    try {
      return c.json({
        ok: true,
        value: await refreshEntitlement(ctx, { force: true }),
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  app.post("/signout", async (c) => {
    try {
      return c.json({ ok: true, value: await signOut(ctx) });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
