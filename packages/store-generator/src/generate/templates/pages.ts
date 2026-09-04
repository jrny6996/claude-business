/** Page templates. Like the components, these are constant strings. */

export function indexAstro(): string {
  return `---
import Layout from "../layouts/Layout.astro";
import Gallery from "../components/Gallery.astro";
import BuyBox from "../components/BuyBox.astro";
import store from "../data/store.json";

const { product } = store;
---

<Layout title={product.title} description={product.description.slice(0, 155)}>
  <div class="wrap">
    <div class="product">
      <Gallery />
      <BuyBox />
    </div>

    {product.description && (
      <section class="section">
        <div class="prose">
          <h2>Details</h2>
          <p>{product.description}</p>
        </div>
      </section>
    )}
  </div>
</Layout>
`;
}

export function cartAstro(): string {
  return `---
import Layout from "../layouts/Layout.astro";
---

<Layout title="Cart">
  <div class="wrap prose">
    <h1>Your cart</h1>

    <div id="cart-lines"></div>

    <p id="cart-empty" hidden>Your cart is empty. <a href="/">Back to the product</a>.</p>

    <div id="cart-summary" hidden>
      <div class="cart-total">
        <span>Total</span>
        <span data-cart-total></span>
      </div>
      <a class="btn btn-primary" id="cart-checkout" href="#">Checkout</a>
      <p class="checkout-note">
        Checkout is hosted by Stripe. Quantities can be adjusted on the Stripe
        page before you pay.
      </p>
    </div>
  </div>
</Layout>

<script>
  import { readCart, removeFromCart, cartTotalCents } from "../lib/cart";
  import store from "../data/store.json";

  const lines = document.getElementById("cart-lines");
  const empty = document.getElementById("cart-empty");
  const summary = document.getElementById("cart-summary");
  const checkout = document.getElementById("cart-checkout");

  const money = (cents) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: store.store.currency,
    }).format(cents / 100);

  const render = () => {
    const items = readCart();
    if (!lines || !empty || !summary) return;

    lines.innerHTML = "";
    empty.hidden = items.length > 0;
    summary.hidden = items.length === 0;

    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "cart-line";

      if (item.image) {
        const img = document.createElement("img");
        img.src = item.image;
        img.alt = "";
        row.appendChild(img);
      }

      const grow = document.createElement("div");
      grow.className = "grow";

      const title = document.createElement("div");
      title.textContent = item.title;
      grow.appendChild(title);

      const opts = document.createElement("div");
      opts.className = "opts";
      opts.textContent =
        Object.entries(item.options)
          .map(([name, value]) => name + ": " + value)
          .join(", ") + (item.quantity > 1 ? "  \\u00d7 " + item.quantity : "");
      grow.appendChild(opts);

      row.appendChild(grow);

      const price = document.createElement("div");
      price.textContent = money(item.priceCents * item.quantity);
      row.appendChild(price);

      const remove = document.createElement("button");
      remove.className = "btn btn-secondary";
      remove.style.width = "auto";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        removeFromCart(index);
        render();
      });
      row.appendChild(remove);

      lines.appendChild(row);
    });

    const total = document.querySelector("[data-cart-total]");
    if (total) total.textContent = money(cartTotalCents());

    // Payment links check out one line item at a time, so the button follows
    // the first item in the cart. A multi-line cart is out of scope for a
    // single-product validation store.
    const first = items[0];
    if (checkout instanceof HTMLAnchorElement) {
      const link = first?.paymentLink || store.checkout.paymentLinkUrl || "";
      if (link) {
        checkout.href = link;
        checkout.removeAttribute("aria-disabled");
      } else {
        checkout.removeAttribute("href");
        checkout.setAttribute("aria-disabled", "true");
      }
    }
  };

  render();
  window.addEventListener("cart:changed", render);
</script>
`;
}

export function policyAstro(kind: "shipping" | "returns"): string {
  const title = kind === "shipping" ? "Shipping" : "Returns";
  const field = kind === "shipping" ? "shippingPolicy" : "returnsPolicy";
  const fallback =
    kind === "shipping"
      ? "Orders are dispatched from our supplier and typically arrive within 10-20 business days. Tracking is provided once your order ships."
      : "If something isn't right, contact us within 30 days of delivery and we'll make it right.";

  return `---
import Layout from "../layouts/Layout.astro";
import store from "../data/store.json";

const body = store.store.${field} || ${JSON.stringify(fallback)};
---

<Layout title="${title}">
  <div class="wrap prose">
    <h1>${title}</h1>
    <p>{body}</p>
    {store.store.supportEmail && (
      <p>
        Questions? Email <a href={"mailto:" + store.store.supportEmail}>
          {store.store.supportEmail}
        </a>.
      </p>
    )}
  </div>
</Layout>
`;
}

export function notFoundAstro(): string {
  return `---
import Layout from "../layouts/Layout.astro";
---

<Layout title="Page not found">
  <div class="wrap prose">
    <h1>Page not found</h1>
    <p>That page doesn't exist. <a href="/">Back to the product</a>.</p>
  </div>
</Layout>
`;
}
