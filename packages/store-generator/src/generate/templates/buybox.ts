/** The purchase path: variant selection, cart, and Stripe-hosted checkout. */

export function buyBoxAstro(): string {
  return `---
import store from "../data/store.json";
import Rating from "./Rating.astro";
import Waitlist from "./Waitlist.astro";

const { product, checkout } = store;
const isStripe =
  checkout.provider === "stripe" &&
  (checkout.hasApi || Boolean(checkout.paymentLinkUrl));
const isWaitlist = checkout.provider === "waitlist";
const optionNames = [
  ...new Set(product.variants.flatMap((variant) => Object.keys(variant.options))),
];
---

<div class="buybox">
  <h1>{product.title}</h1>

  <Rating />

  <div class="price-row">
    <span class="price" data-price-display>{product.priceDisplay}</span>
    {product.compareAtDisplay && (
      <span class="price-compare">{product.compareAtDisplay}</span>
    )}
    {product.compareAtDisplay && <span class="badge">Sale</span>}
  </div>

  {product.highlights.length > 0 && (
    <ul class="highlights">
      {product.highlights.map((highlight) => <li>{highlight}</li>)}
    </ul>
  )}

  <div
    id="buy-controls"
    data-variants={JSON.stringify(product.variants)}
    data-variant-links={JSON.stringify(checkout.variantPaymentLinks)}
    data-payment-link={checkout.paymentLinkUrl ?? ""}
    data-product-id={product.id}
    data-product-title={product.title}
    data-product-image={product.images[0]?.url ?? ""}
  >
    {optionNames.map((name) => (
      <div class="field">
        <label for={"option-" + name}>{name}</label>
        <select id={"option-" + name} data-option={name}>
          {[
            ...new Set(
              product.variants
                .map((variant) => variant.options[name])
                .filter((value) => Boolean(value)),
            ),
          ].map((value) => <option value={value}>{value}</option>)}
        </select>
      </div>
    ))}

    {!isWaitlist && (
      <div class="field">
        <label for="quantity">Quantity</label>
        <input id="quantity" type="number" min="1" max="99" value="1" />
      </div>
    )}

    {isStripe && (
      <>
        {checkout.hasApi ? (
          <button class="btn btn-primary" type="button" data-buy-now data-checkout-api>
            Buy now
          </button>
        ) : (
          <a class="btn btn-primary" data-buy-now href={checkout.paymentLinkUrl}>
            Buy now
          </a>
        )}
        <p style="height: 8px"></p>
        <button class="btn btn-secondary" type="button" data-add-to-cart>
          Add to cart
        </button>
        <p class="checkout-note">
          Secure checkout is hosted by Stripe. You'll be redirected to complete
          your purchase.
        </p>
        <p class="checkout-note" data-checkout-error role="alert"></p>
      </>
    )}

    {isWaitlist && <Waitlist />}

    {!isStripe && !isWaitlist && (
      <>
        <span class="btn btn-primary" aria-disabled="true" data-buy-now>Buy now</span>
        <p class="checkout-note">
          Checkout isn't connected yet. Add your Stripe secret key in the app and
          regenerate this store to enable payments.
        </p>
      </>
    )}
  </div>

  {product.shipsFrom && (
    <p class="checkout-note">Ships from {product.shipsFrom}</p>
  )}
</div>

<script>
  import { addToCart, selectedVariant, paymentLinkFor, startCheckout } from "../lib/cart";

  const root = document.getElementById("buy-controls");
  if (root) {
    const quantityInput = document.getElementById("quantity");
    const buyNow = root.querySelector("[data-buy-now]");
    const priceDisplay = document.querySelector("[data-price-display]");

    const readOptions = () => {
      const options = {};
      root.querySelectorAll("[data-option]").forEach((select) => {
        const name = select.getAttribute("data-option");
        if (name && select instanceof HTMLSelectElement) options[name] = select.value;
      });
      return options;
    };

    const sync = () => {
      const variant = selectedVariant(root, readOptions());

      if (variant && priceDisplay) priceDisplay.textContent = variant.priceDisplay;

      const link = paymentLinkFor(root, variant);
      if (buyNow instanceof HTMLAnchorElement && link) buyNow.href = link;
      if (buyNow instanceof HTMLButtonElement) {
        buyNow.dataset.variantId = variant ? variant.id : "";
      }

      // Waitlist stores record which variant the visitor was looking at.
      const hidden = document.querySelector("[data-waitlist-variant]");
      if (hidden instanceof HTMLInputElement) {
        hidden.value = Object.entries(readOptions())
          .map(([name, value]) => name + ": " + value)
          .join(", ");
      }
    };

    root.querySelectorAll("[data-option]").forEach((select) => {
      select.addEventListener("change", sync);
    });

    root.querySelector("[data-add-to-cart]")?.addEventListener("click", () => {
      const quantity =
        quantityInput instanceof HTMLInputElement
          ? Math.max(1, Number.parseInt(quantityInput.value, 10) || 1)
          : 1;

      addToCart(root, readOptions(), quantity);
      window.location.href = "/cart/";
    });

    // API checkout: the server prices the order, so the browser only ever says
    // which variant and how many.
    if (buyNow instanceof HTMLButtonElement && buyNow.dataset.checkoutApi !== undefined) {
      buyNow.addEventListener("click", async () => {
        const quantity =
          quantityInput instanceof HTMLInputElement
            ? Math.max(1, Number.parseInt(quantityInput.value, 10) || 1)
            : 1;

        buyNow.disabled = true;
        const original = buyNow.textContent;
        buyNow.textContent = "Starting checkout\u2026";

        try {
          await startCheckout([
            { variantId: buyNow.dataset.variantId || null, quantity },
          ]);
        } catch (error) {
          buyNow.disabled = false;
          buyNow.textContent = original;
          const note = document.querySelector("[data-checkout-error]");
          if (note) note.textContent = error instanceof Error ? error.message : "";
        }
      });
    }

    sync();
  }
</script>
`;
}

/**
 * The waitlist capture used by free-tier stores.
 *
 * Posts to the store owner's own form endpoint. If they haven't set one it
 * degrades to a `mailto:` on their support address, so the button is never
 * dead. Either way the addresses go to them, never to us — a static store has
 * nowhere to keep them and we are not a backend.
 */
export function waitlistAstro(): string {
  return `---
import store from "../data/store.json";

const { checkout, store: shop } = store;
const endpoint = checkout.waitlistEndpoint;
const mailto = shop.supportEmail
  ? "mailto:" + shop.supportEmail + "?subject=" + encodeURIComponent("Waitlist: " + store.product.title)
  : null;
---

<div class="waitlist">
  {endpoint ? (
    <form class="waitlist-form" method="POST" action={endpoint} data-waitlist>
      <input type="hidden" name="product" value={store.product.title} />
      <input type="hidden" name="variant" value="" data-waitlist-variant />
      <div class="field">
        <label for="waitlist-email">Email</label>
        <input
          id="waitlist-email"
          class="waitlist-input"
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          autocomplete="email"
        />
      </div>
      <button class="btn btn-primary" type="submit">Join the waitlist</button>
      <p class="checkout-note" data-waitlist-status role="status">
        Be first to know when this launches.
      </p>
    </form>
  ) : mailto ? (
    <>
      <a class="btn btn-primary" href={mailto}>Join the waitlist</a>
      <p class="checkout-note">
        Opens your email app so you can register interest.
      </p>
    </>
  ) : (
    <>
      <span class="btn btn-primary" aria-disabled="true">Join the waitlist</span>
      <p class="checkout-note">
        No waitlist destination is set. Add a form endpoint or a support email in
        the app and regenerate this store.
      </p>
    </>
  )}
</div>

<script>
  const form = document.querySelector("[data-waitlist]");
  const status = document.querySelector("[data-waitlist-status]");

  form?.addEventListener("submit", async (event) => {
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();

    const button = form.querySelector("button[type=submit]");
    if (button instanceof HTMLButtonElement) button.disabled = true;
    if (status) status.textContent = "Adding you\u2026";

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new FormData(form),
      });
      if (!response.ok) throw new Error(String(response.status));
      form.reset();
      if (status) status.textContent = "You're on the list. Thanks!";
    } catch {
      // The endpoint belongs to the store owner, so we can't diagnose it for
      // the visitor — just don't pretend it worked.
      if (status) {
        status.textContent = "That didn't go through. Please try again later.";
      }
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  });
</script>
`;
}

/**
 * The cart helper shipped into the generated store.
 *
 * Cart state is per-browser `localStorage` only — the storefront has no
 * backend, and we are not one. Checkout hands off to a Stripe-hosted page.
 */
export function cartLibTs(): string {
  return `const STORAGE_KEY = "cart:v1";

export interface CartItem {
  productId: string;
  /** Which variant, so the checkout API can price the line itself. */
  variantId: string | null;
  title: string;
  image: string;
  options: Record<string, string>;
  quantity: number;
  priceCents: number;
  priceDisplay: string;
  paymentLink: string;
}

interface Variant {
  id: string;
  options: Record<string, string>;
  available: boolean;
  priceCents: number;
  priceDisplay: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readCart(): CartItem[] {
  if (typeof localStorage === "undefined") return [];
  const items = parseJson<CartItem[]>(localStorage.getItem(STORAGE_KEY), []);
  return Array.isArray(items) ? items : [];
}

export function writeCart(items: CartItem[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent("cart:changed"));
}

export function cartCount(): number {
  return readCart().reduce((total, item) => total + item.quantity, 0);
}

export function cartTotalCents(): number {
  return readCart().reduce((total, item) => total + item.priceCents * item.quantity, 0);
}

function dataset<T>(root: Element, attribute: string, fallback: T): T {
  return parseJson<T>(root.getAttribute(attribute), fallback);
}

/** Finds the variant matching every currently-selected option. */
export function selectedVariant(
  root: Element,
  options: Record<string, string>,
): Variant | null {
  const variants = dataset<Variant[]>(root, "data-variants", []);
  if (variants.length === 0) return null;

  const match = variants.find((variant) =>
    Object.entries(options).every(([name, value]) => variant.options[name] === value),
  );
  return match ?? variants[0] ?? null;
}

/** Variant-specific Stripe link when one exists, else the base product link. */
export function paymentLinkFor(root: Element, variant: Variant | null): string {
  const links = dataset<Record<string, string>>(root, "data-variant-links", {});
  const base = root.getAttribute("data-payment-link") ?? "";
  if (variant && links[variant.id]) return links[variant.id];
  return base;
}

export function addToCart(
  root: Element,
  options: Record<string, string>,
  quantity: number,
): void {
  const variant = selectedVariant(root, options);
  const items = readCart();

  const productId = root.getAttribute("data-product-id") ?? "product";
  const key = productId + "|" + JSON.stringify(options);

  const existing = items.find(
    (item) => item.productId + "|" + JSON.stringify(item.options) === key,
  );

  if (existing) {
    existing.quantity = Math.min(99, existing.quantity + quantity);
  } else {
    items.push({
      productId,
      variantId: variant ? variant.id : null,
      title: root.getAttribute("data-product-title") ?? "Product",
      image: root.getAttribute("data-product-image") ?? "",
      options,
      quantity,
      priceCents: variant?.priceCents ?? 0,
      priceDisplay: variant?.priceDisplay ?? "",
      paymentLink: paymentLinkFor(root, variant),
    });
  }

  writeCart(items);
}

export function removeFromCart(index: number): void {
  const items = readCart();
  items.splice(index, 1);
  writeCart(items);
}

export function clearCart(): void {
  writeCart([]);
}

/**
 * Starts a Stripe Checkout Session through this store's own API route.
 *
 * Only variant ids and quantities are sent: the endpoint reads prices from the
 * store's own data, so a tampered request can't change what anything costs.
 */
export async function startCheckout(
  items: { variantId: string | null; quantity: number }[],
): Promise<void> {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  const body = (await response.json().catch(() => null)) as
    | { url?: string; error?: string }
    | null;

  if (!response.ok || !body?.url) {
    throw new Error(body?.error ?? "Couldn't start checkout. Please try again.");
  }

  window.location.href = body.url;
}
`;
}
