import { Hono } from "hono";
import { z } from "zod";
import { nowOf, type CloudContext } from "../context.js";
import { issueLicense } from "../services/issuer.js";
import { licenseEmail } from "../services/mail.js";
import { respondWithError } from "./errors.js";

const RecoverBody = z.object({ email: z.email() });
const CompleteQuery = z.object({ sessionId: z.string().min(1) });

/**
 * Getting a licence back.
 *
 * The service keeps no customer database: Stripe already has one, and a second
 * copy would be a second thing to secure, keep in sync and delete on request.
 * Recovery therefore looks the buyer up in Stripe and re-mints from the live
 * subscription — which also means a licence can never disagree with what
 * someone is actually paying for.
 */
export function licenseRoutes(ctx: CloudContext): Hono {
  const app = new Hono();

  /**
   * Re-sends the current licence to the address that bought it.
   *
   * Always answers the same way, whether or not that address has ever bought
   * anything. Otherwise this is an oracle for "does this person use the
   * product", answerable by anyone.
   */
  app.post("/recover", async (c) => {
    const generic = {
      ok: true,
      value: {
        message:
          "If that address has an active subscription, its licence key is on its way.",
      },
    };

    try {
      const body = RecoverBody.parse(await c.req.json());
      const subscriptions = await ctx.stripe.findActiveSubscriptionsByEmail(
        body.email,
      );

      for (const subscription of subscriptions.slice(0, 1)) {
        const { key, payload } = issueLicense(
          {
            email: body.email,
            subscriptionId: subscription.id,
            periodEnd: subscription.current_period_end,
            issuedAt: nowOf(ctx),
          },
          ctx.licensePrivateKeyPem,
        );

        await ctx.mailer.send({
          ...licenseEmail(key, payload.expiresAt),
          to: body.email,
        });
      }

      return c.json(generic);
    } catch (cause) {
      // A malformed address is worth reporting; anything else must not
      // distinguish "no such customer" from "email provider is down".
      if (cause instanceof z.ZodError) return respondWithError(c, cause);
      console.error("[cloud] licence recovery failed", cause);
      return c.json(generic);
    }
  });

  /**
   * The licence for a just-completed checkout, for the success page.
   *
   * The session id is a bearer capability handed back by Stripe's redirect, so
   * this is only as strong as that URL — but the same key is emailed anyway,
   * and showing it immediately is the difference between a purchase that feels
   * finished and one that leaves the buyer waiting on an inbox.
   */
  app.get("/complete", async (c) => {
    try {
      const { sessionId } = CompleteQuery.parse({
        sessionId: c.req.query("session_id"),
      });

      const session = await ctx.stripe.getCheckoutSession(sessionId);
      if (!session.subscription) {
        return c.json({
          ok: true,
          value: { status: "pending", key: null },
        });
      }

      const subscription = await ctx.stripe.getSubscription(session.subscription);
      if (subscription.status !== "active" && subscription.status !== "trialing") {
        return c.json({ ok: true, value: { status: "pending", key: null } });
      }

      const email =
        session.customer_email ??
        (await ctx.stripe.getCustomer(subscription.customer)).email;

      if (!email) {
        return c.json({ ok: true, value: { status: "pending", key: null } });
      }

      const { key, payload } = issueLicense(
        {
          email,
          subscriptionId: subscription.id,
          periodEnd: subscription.current_period_end,
          issuedAt: nowOf(ctx),
        },
        ctx.licensePrivateKeyPem,
      );

      return c.json({
        ok: true,
        value: {
          status: "ready",
          key,
          email,
          expiresAt: payload.expiresAt,
        },
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
