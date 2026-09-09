import { Hono } from "hono";
import { nowOf, type CloudContext } from "../context.js";
import { issueLicense } from "../services/issuer.js";
import { licenseEmail } from "../services/mail.js";
import { verifyStripeSignature } from "../services/webhook-signature.js";

/**
 * The Stripe webhook. The only thing that causes a licence to be minted.
 *
 * Events handled, and why each one:
 *
 * - `checkout.session.completed` — the first purchase. Issue and email.
 * - `invoice.paid` — a renewal. Re-issue with the new period end. Because the
 *   licence id is derived from the subscription id, the renewed key is the same
 *   identity with a later expiry, so the subscriber's cloud backups stay theirs.
 * - `customer.subscription.deleted` — a cancellation. Deliberately **nothing**.
 *   The outstanding licence already expires at period end, so a cancelled
 *   subscriber keeps what they paid for and then lapses on their own. Revoking
 *   early would be taking back a period they have already paid for.
 *
 * Anything else is acknowledged and ignored. Returning a non-2xx to Stripe for
 * an event we simply don't care about makes it retry for days.
 */
interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

export function webhookRoutes(ctx: CloudContext): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    // The raw body, not the parsed one. The signature covers these exact bytes,
    // and re-serialising parsed JSON would change them.
    const rawBody = await c.req.text();

    const check = verifyStripeSignature({
      rawBody,
      header: c.req.header("stripe-signature"),
      secret: ctx.stripeWebhookSecret,
      now: nowOf(ctx),
    });

    if (!check.valid) {
      // The reason is logged, never returned: telling an unauthenticated caller
      // *why* their forgery failed helps them fix it.
      console.warn(`[cloud] rejected webhook: ${check.reason}`);
      return c.json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid signature." } }, 401);
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      return c.json({ ok: false, error: { code: "VALIDATION_FAILED", message: "Malformed event." } }, 400);
    }

    try {
      await handleEvent(ctx, event);
    } catch (cause) {
      // A 500 makes Stripe retry, which is what we want for a transient
      // failure — the handler is safe to run twice.
      console.error(`[cloud] webhook ${event.type} failed`, cause);
      return c.json({ ok: false, error: { code: "INTERNAL", message: "Event handling failed." } }, 500);
    }

    return c.json({ ok: true, value: { received: true } });
  });

  return app;
}

async function handleEvent(ctx: CloudContext, event: StripeEvent): Promise<void> {
  const object = event.data?.object ?? {};

  const subscriptionId =
    event.type === "checkout.session.completed"
      ? stringOrNull(object.subscription)
      : event.type === "invoice.paid"
        ? stringOrNull(object.subscription) ?? stringOrNull(object.parent)
        : null;

  if (!subscriptionId) return;

  const subscription = await ctx.stripe.getSubscription(subscriptionId);

  // A subscription that isn't paying doesn't get a key. `past_due` in
  // particular arrives here on a failed renewal and must not extend anything.
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return;
  }

  const email =
    stringOrNull(object.customer_email) ??
    stringOrNull((object.customer_details as Record<string, unknown> | undefined)?.email) ??
    (await ctx.stripe.getCustomer(subscription.customer)).email;

  if (!email) {
    throw new Error(`no email for subscription ${subscriptionId}`);
  }

  const { key, payload } = issueLicense(
    {
      email,
      subscriptionId,
      periodEnd: subscription.current_period_end,
      issuedAt: nowOf(ctx),
    },
    ctx.licensePrivateKeyPem,
  );

  try {
    await ctx.mailer.send({ ...licenseEmail(key, payload.expiresAt), to: email });
  } catch (cause) {
    // Delivery failing must not fail the webhook: the payment succeeded, and
    // the buyer can retrieve the key from the success page or by recovery.
    // Retrying the whole event would re-issue a licence that already exists.
    console.error(`[cloud] couldn't email licence to ${email}`, cause);
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
