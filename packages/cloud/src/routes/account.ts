import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@repo/shared";
import { nowOf, type CloudContext } from "../context.js";
import {
  accountForDeviceToken,
  issueSigninCode,
  redeemSigninCode,
  revokeDeviceToken,
  SIGNIN_CODE_TTL_MINUTES,
} from "../services/accounts.js";
import { buildEntitlement } from "../services/entitlement.js";
import { signinCodeEmail } from "../services/mail.js";
import { respondWithError } from "./errors.js";

const EmailBody = z.object({ email: z.email() });
const VerifyBody = z.object({
  email: z.email(),
  code: z.string().trim().min(4).max(12),
});

/**
 * Accounts: signing in, and asking what you're entitled to.
 *
 * There are no passwords. A mailed code proves control of the address, and is
 * exchanged once for a durable device token; from then on the app refreshes its
 * own entitlement and a subscriber never sees a renewal.
 */
export function accountRoutes(ctx: CloudContext): Hono {
  const app = new Hono();

  /**
   * Starts sign-in. Always answers the same way — otherwise this reports
   * whether an address is a customer to anyone who asks.
   */
  app.post("/signin", async (c) => {
    const generic = {
      ok: true,
      value: {
        message: `If that address can sign in, a code is on its way. It expires in ${SIGNIN_CODE_TTL_MINUTES} minutes.`,
      },
    };

    try {
      const body = EmailBody.parse(await c.req.json());
      const { code } = await issueSigninCode(ctx, body.email);

      await ctx.mailer.send({
        ...signinCodeEmail(code, SIGNIN_CODE_TTL_MINUTES),
        to: body.email,
      });

      return c.json(generic);
    } catch (cause) {
      if (cause instanceof z.ZodError) return respondWithError(c, cause);
      // A mail outage must not be distinguishable from an unknown address.
      console.error("[cloud] sign-in code failed", cause);
      return c.json(generic);
    }
  });

  /** Exchanges the mailed code for a device token plus a first entitlement. */
  app.post("/verify", async (c) => {
    try {
      const body = VerifyBody.parse(await c.req.json());
      const { account, deviceToken } = await redeemSigninCode(
        ctx,
        body.email,
        body.code,
      );

      return c.json({
        ok: true,
        value: {
          deviceToken,
          entitlement: buildEntitlement(account, nowOf(ctx)),
        },
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  /**
   * The current entitlement for whoever holds this device token.
   *
   * The app calls this on a schedule and caches the signed result, so it keeps
   * working offline and a renewal needs no action from the subscriber.
   */
  app.get("/entitlement", async (c) => {
    try {
      const account = await accountForDeviceToken(ctx, bearer(c.req.raw));
      if (!account) {
        throw new AppError(
          "UNAUTHORIZED",
          "This device is signed out. Sign in again to check your subscription.",
        );
      }

      return c.json({
        ok: true,
        value: { entitlement: buildEntitlement(account, nowOf(ctx)) },
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  /** Signs this device out. Other devices on the account are unaffected. */
  app.delete("/device", async (c) => {
    try {
      await revokeDeviceToken(ctx, bearer(c.req.raw));
      return c.json({ ok: true, value: { signedOut: true } });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");

  if (!scheme || scheme.toLowerCase() !== "bearer" || rest.length === 0) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", "missing bearer token");
  }
  return rest.join(" ").trim();
}
