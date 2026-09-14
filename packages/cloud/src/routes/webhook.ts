import { Hono } from "hono";
import { nowOf, type CloudContext } from "../context.js";
import { applySubscriptionState, type SubscriptionStatus } from "../services/accounts.js";
import { accountNamespace, issueLicense, licenseIdForSubscription } from "../services/issuer.js";
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
 * - `customer.subscription.deleted` / `.updated` — the account's recorded
 *   status changes, but entitlement still runs to the period end. A subscriber
 *   who cancels keeps what they paid for and lapses on their own; revoking
 *   early would be taking back a period they have already bought.
 *
 * Every one of these also writes the subscription's state onto the account,
 * which is what the desktop app actually reads. The licence mail is kept
 * alongside it so customers who activated a key before accounts existed keep
 * working — that path can go once none are in circulation.
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
        : event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.deleted"
          ? stringOrNull(object.id)
          : null;

  if (!subscriptionId) return;

  const subscription = await ctx.stripe.getSubscription(subscriptionId);

  const email =
    stringOrNull(object.customer_email) ??
    stringOrNull((object.customer_details as Record<string, unknown> | undefined)?.email) ??
    (await ctx.stripe.getCustomer(subscription.customer)).email;

  if (!email) {
    throw new Error(`no email for subscription ${subscriptionId}`);
  }

  // Recorded first, and for every status — including the ones that end the
  // subscription. This is the state the app reads, so a cancellation that never
  // lands here would leave someone premium indefinitely.
  await applySubscriptionState(ctx, {
    email,
    stripeCustomerId: subscription.customer,
    subscriptionId,
    status: normalizeStatus(subscription.status),
    periodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    backupNamespace: accountNamespace(licenseIdForSubscription(subscriptionId)),
  });

  // Only a purchase or a renewal mints a key. Gating on the event type rather
  // than the subscription's status matters: a cancellation event can arrive
  // while Stripe still reports the subscription active, and issuing there
  // would email a fresh key to someone who just cancelled.
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "invoice.paid"
  ) {
    return;
  }

  // A subscription that isn't paying doesn't get a key. `past_due` in
  // particular arrives here on a failed renewal and must not extend anything.
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return;
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

/** Stripe has more states than entitlement cares about; fold the rest in. */
function normalizeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
      return status;
    case "unpaid":
    case "incomplete_expired":
      return "canceled";
    default:
      return "none";
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
