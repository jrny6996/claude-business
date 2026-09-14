import { Hono } from "hono";
import { z } from "zod";
import type { CloudContext } from "../context.js";
import { respondWithError } from "./errors.js";

const CheckoutBody = z.object({
  /** Optional: prefills Stripe's form. Stripe collects it either way. */
  email: z.email().optional(),
});

/**
 * Selling our own premium subscription.
 *
 * This is us taking money for our own product, which is unrelated to the
 * storefront payment path we stay out of. No user's Stripe key is involved and
 * no card data reaches us — the buyer goes to Stripe's hosted page, same as
 * their customers do on a generated store.
 *
 * **The price is not in this codebase.** It lives on a Stripe Price object
 * named by `PREMIUM_PRICE_ID`, so it can be set, changed and A/B tested
 * without a deploy — and so nobody has to guess a number here while that
 * decision is still open. `/api/pricing` reads it back for the landing page,
 * which is why the page can show a real figure without one being hardcoded.
 */
export function checkoutRoutes(ctx: CloudContext): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    try {
      const body = CheckoutBody.parse(await c.req.json().catch(() => ({})));

      if (!ctx.config.premiumPriceId) {
        return respondWithError(
          c,
          new Error("PREMIUM_PRICE_ID is not configured"),
        );
      }

      const session = await ctx.stripe.createSubscriptionCheckout({
        priceId: ctx.config.premiumPriceId,
        successUrl: `${ctx.config.siteUrl}/purchase/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${ctx.config.siteUrl}/#pricing`,
        ...(body.email ? { email: body.email } : {}),
      });

      return c.json({ ok: true, value: { url: session.url, id: session.id } });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  /**
   * The configured price, for the landing page to render.
   *
   * Returned as raw minor units and a currency rather than a formatted string,
   * so the page decides presentation. Cached at the edge for a few minutes: it
   * changes rarely and this is on the path of every page view.
   */
  app.get("/price", async (c) => {
    try {
      if (!ctx.config.premiumPriceId) {
        return c.json({ ok: true, value: null });
      }

      const price = await ctx.stripe.getPrice(ctx.config.premiumPriceId);

      c.header("Cache-Control", "public, max-age=300, s-maxage=300");
      return c.json({
        ok: true,
        value: {
          amountMinor: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval ?? null,
          intervalCount: price.recurring?.interval_count ?? 1,
        },
      });
    } catch (cause) {
      return respondWithError(c, cause);
    }
  });

  return app;
}
