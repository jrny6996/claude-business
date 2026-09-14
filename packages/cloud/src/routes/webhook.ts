import { Hono } from "hono";
import { nowOf, type CloudContext } from "../context.js";
import { applySubscriptionState, type SubscriptionStatus } from "../services/accounts.js";
import { backupNamespaceForSubscription } from "../services/namespaces.js";
import { verifyStripeSignature } from "../services/webhook-signature.js";

/**
 * The Stripe webhook. The only thing that may change a subscription's state.
 *
 * Every handled event does the same thing: write what Stripe says onto the
 * account. Nothing is minted and nothing is emailed — the app asks for its own
 * entitlement, so there is no artefact to deliver.
 *
 * - `checkout.session.completed` — the first purchase.
 * - `invoice.paid` — a renewal, which moves the period end.
 * - `customer.subscription.updated` / `.deleted` — status changes, including
 *   the ones that end it. Recording these is what stops a cancelled subscriber
 *   staying premium forever; entitlement still runs to the period end, because
 *   revoking early takes back something already paid for.
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
    backupNamespace: backupNamespaceForSubscription(subscriptionId),
  });

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
