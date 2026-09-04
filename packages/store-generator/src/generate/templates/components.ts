/**
 * Astro component templates.
 *
 * Every one of these is a constant string: all product data reaches the
 * storefront through `src/data/store.json`, never through string
 * interpolation. That is what makes it safe to generate a store for a product
 * whose title contains quotes, angle brackets or emoji.
 */

export function layoutAstro(): string {
  return `---
import "../styles/theme.css";
import "../styles/global.css";
import store from "../data/store.json";
import Header from "../components/Header.astro";
import Footer from "../components/Footer.astro";

interface Props {
  title?: string;
  description?: string;
}

const { title, description } = Astro.props;
const pageTitle = title ? title + " \\u00b7 " + store.store.name : store.store.name;
const pageDescription = description ?? store.store.tagline ?? store.product.title;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{pageTitle}</title>
    <meta name="description" content={pageDescription} />
    <meta property="og:title" content={pageTitle} />
    <meta property="og:description" content={pageDescription} />
    {store.product.images[0] && (
      <meta property="og:image" content={store.product.images[0].url} />
    )}
    <meta name="generator" content={Astro.generator} />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <Header />
    <main>
      <slot />
    </main>
    <Footer />
  </body>
</html>
`;
}

export function headerAstro(): string {
  return `---
import store from "../data/store.json";
---

<header class="site-header">
  <div class="wrap">
    <div>
      <a class="brand" href="/">{store.store.name}</a>
      {store.store.tagline && <div class="brand-tagline">{store.store.tagline}</div>}
    </div>
    <nav class="nav">
      <a href="/">Product</a>
      <a href="/shipping/">Shipping</a>
      <a href="/returns/">Returns</a>
      <a href="/cart/">Cart (<span data-cart-count>0</span>)</a>
    </nav>
  </div>
</header>

<script>
  import { cartCount } from "../lib/cart";

  const render = () => {
    const count = cartCount();
    document.querySelectorAll("[data-cart-count]").forEach((node) => {
      node.textContent = String(count);
    });
  };

  render();
  window.addEventListener("storage", render);
  window.addEventListener("cart:changed", render);
</script>
`;
}

export function footerAstro(): string {
  return `---
import store from "../data/store.json";

const year = new Date().getFullYear();
---

<footer class="site-footer">
  <div class="wrap">
    <span>&copy; {year} {store.store.name}</span>
    <span>
      {store.store.supportEmail && (
        <a href={"mailto:" + store.store.supportEmail}>{store.store.supportEmail}</a>
      )}
    </span>
  </div>
</footer>
`;
}

export function ratingAstro(): string {
  return `---
import store from "../data/store.json";

const { ratingAverage, ratingCount } = store.product;
const rounded = ratingAverage === null ? 0 : Math.round(ratingAverage);
const stars = "\\u2605".repeat(rounded) + "\\u2606".repeat(Math.max(0, 5 - rounded));
---

{ratingAverage !== null && (
  <p class="rating">
    <span class="stars" aria-hidden="true">{stars}</span>
    <span class="visually-hidden">{ratingAverage.toFixed(1)} out of 5</span>
    {" "}
    {ratingAverage.toFixed(1)}
    {ratingCount !== null && <span> ({ratingCount.toLocaleString()} reviews)</span>}
  </p>
)}
`;
}

export function galleryAstro(): string {
  return `---
import store from "../data/store.json";

const images = store.product.images.slice(0, 10);
const primary = images[0];
---

<div class="gallery">
  <div class="gallery-main">
    {primary ? (
      <img
        id="gallery-main-image"
        src={primary.url}
        alt={primary.alt || store.product.title}
        width="800"
        height="800"
        loading="eager"
      />
    ) : (
      <div aria-hidden="true"></div>
    )}
  </div>

  {images.length > 1 && (
    <ul class="gallery-thumbs">
      {images.map((image, index) => (
        <li>
          <button
            type="button"
            data-gallery-thumb
            data-src={image.url}
            aria-current={index === 0 ? "true" : "false"}
            aria-label={"View image " + (index + 1)}
          >
            <img src={image.url} alt="" width="120" height="120" loading="lazy" />
          </button>
        </li>
      ))}
    </ul>
  )}
</div>

<script>
  const main = document.getElementById("gallery-main-image");
  const thumbs = document.querySelectorAll("[data-gallery-thumb]");

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      const src = thumb.getAttribute("data-src");
      if (!src || !(main instanceof HTMLImageElement)) return;

      main.src = src;
      thumbs.forEach((other) => other.setAttribute("aria-current", "false"));
      thumb.setAttribute("aria-current", "true");
    });
  });
</script>
`;
}
