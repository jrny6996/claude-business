/**
 * The REST checkout endpoint shipped inside a generated store.
 *
 * Runs as a serverless function on the **store owner's** Vercel or Netlify,
 * reading `STRIPE_SECRET_KEY` from that host's environment. The key never
 * reaches us: with this mode the desktop app doesn't need a Stripe key at all.
 *
 * The one rule that matters here: **prices are read from the store's own data,
 * never from the request.** A browser can say which variant and how many, and
 * nothing else. Trusting a client-sent amount is how storefronts get bought for
 * a penny.
 */
export function checkoutApiTs(): string {
  return `import type { APIRoute } from "astro";
import store from "../../data/store.json";

// This route must not be prerendered — it needs to run per request.
export const prerender = false;

interface LineItemRequest {
  variantId?: string | null;
  quantity?: number;
}

interface ResolvedLine {
  name: string;
  unitAmount: number;
  quantity: number;
}

const CURRENCY = store.store.currency.toLowerCase();
const MAX_QUANTITY = 99;

/**
 * Resolves a requested line against the store's own catalogue.
 *
 * Returns null for anything unrecognised rather than guessing, so a tampered
 * request fails closed.
 */
function resolveLine(line: LineItemRequest): ResolvedLine | null {
  const quantity = Math.min(
    MAX_QUANTITY,
    Math.max(1, Math.floor(Number(line.quantity) || 1)),
  );

  if (!line.variantId) {
    return {
      name: store.product.title,
      unitAmount: store.product.priceCents,
      quantity,
    };
  }

  const variant = store.product.variants.find((v) => v.id === line.variantId);
  if (!variant || !variant.available) return null;

  const options = Object.entries(variant.options)
    .map(([key, value]) => key + ": " + value)
    .join(", ");

  return {
    name: options ? store.product.title + " (" + options + ")" : store.product.title,
    unitAmount: variant.priceCents,
    quantity,
  };
}

function form(lines: ResolvedLine[], origin: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", origin + "/checkout/success/?session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", origin + "/");

  lines.forEach((line, index) => {
    const key = "line_items[" + index + "]";
    params.set(key + "[quantity]", String(line.quantity));
    params.set(key + "[price_data][currency]", CURRENCY);
    params.set(key + "[price_data][unit_amount]", String(line.unitAmount));
    params.set(key + "[price_data][product_data][name]", line.name.slice(0, 250));
    if (store.product.images[0]) {
      params.set(key + "[price_data][product_data][images][0]", store.product.images[0].url);
    }
  });

  return params;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const POST: APIRoute = async ({ request, url }) => {
  const secretKey = import.meta.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    // A misconfigured deploy, not a shopper problem — say so plainly in the
    // logs and give the browser something it can show.
    console.error("[checkout] STRIPE_SECRET_KEY is not set in this environment.");
    return json({ error: "Checkout isn't configured for this store yet." }, 503);
  }

  let payload: { items?: LineItemRequest[] };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  const requested = Array.isArray(payload.items) ? payload.items.slice(0, 20) : [];
  const lines = requested.map(resolveLine).filter((line): line is ResolvedLine => line !== null);

  if (lines.length === 0) {
    return json({ error: "Nothing in this order is available to buy." }, 400);
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secretKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form(lines, url.origin).toString(),
  });

  const body = (await response.json()) as { url?: string; error?: { message?: string } };

  if (!response.ok || !body.url) {
    console.error("[checkout] Stripe rejected the session:", body.error?.message);
    return json({ error: "Couldn't start checkout. Please try again." }, 502);
  }

  return json({ url: body.url }, 200);
};
`;
}

/** Confirmation page shoppers land on after paying. */
export function checkoutSuccessAstro(): string {
  return `---
import Layout from "../../layouts/Layout.astro";
import store from "../../data/store.json";
---

<Layout title="Thank you">
  <div class="wrap prose">
    <h1>Thank you</h1>
    <p>
      Your order is confirmed and a receipt is on its way from Stripe.
    </p>
    {store.store.supportEmail && (
      <p>
        Questions? Email <a href={"mailto:" + store.store.supportEmail}>
          {store.store.supportEmail}
        </a>.
      </p>
    )}
    <p><a href="/">Back to the store</a></p>
  </div>
</Layout>

<script>
  // The cart has been paid for; don't leave it sitting in the browser.
  import { clearCart } from "../../lib/cart";
  clearCart();
</script>
`;
}
