import type { SiteContext } from "../context.js";

/** Astro version the generated storefront is pinned to. */
export const ASTRO_VERSION = "^7.3.1";

const ADAPTERS: Record<string, { pkg: string; version: string }> = {
  vercel: { pkg: "@astrojs/vercel", version: "^11.0.10" },
  netlify: { pkg: "@astrojs/netlify", version: "^8.2.5" },
};

/** The adapter a store needs, or null for a purely static build. */
export function adapterFor(ctx: SiteContext): { pkg: string; version: string } | null {
  if (!ctx.hasCheckoutApi) return null;
  return ADAPTERS[ctx.config.deployTarget] ?? null;
}

export function packageJson(ctx: SiteContext): string {
  const adapter = adapterFor(ctx);

  return (
    JSON.stringify(
      {
        name: ctx.packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "astro dev",
          build: "astro build",
          preview: "astro preview",
        },
        dependencies: {
          astro: ASTRO_VERSION,
          ...(adapter ? { [adapter.pkg]: adapter.version } : {}),
        },
      },
      null,
      2,
    ) + "\n"
  );
}

export function astroConfig(ctx: SiteContext): string {
  const adapter = adapterFor(ctx);

  if (!adapter) {
    return `import { defineConfig } from "astro/config";

// Static output: the whole storefront is prerendered to plain files, so it can
// be dropped on any host. There is no server runtime to pay for.
export default defineConfig({
  output: "static",
  build: {
    format: "directory",
  },
});
`;
  }

  const importName = ctx.config.deployTarget === "vercel" ? "vercel" : "netlify";

  return `import { defineConfig } from "astro/config";
import ${importName} from "${adapter.pkg}";

// Every page is still prerendered to static files. The one exception is
// src/pages/api/checkout.ts, which opts out with \`export const prerender = false\`
// and runs as a serverless function on your own hosting account.
export default defineConfig({
  output: "static",
  adapter: ${importName}(),
  build: {
    format: "directory",
  },
});
`;
}

export function tsconfig(): string {
  return (
    JSON.stringify(
      {
        extends: "astro/tsconfigs/strict",
        include: [".astro/types.d.ts", "**/*"],
        exclude: ["dist"],
      },
      null,
      2,
    ) + "\n"
  );
}

export function gitignore(): string {
  // .env is listed before anything else on purpose: it is the only file here
  // that can hold a live Stripe key, and committing it is the one mistake that
  // actually costs the user money.
  return `.env
.env.*
!.env.example
dist/
.astro/
node_modules/
.DS_Store
`;
}

export function robotsTxt(): string {
  return `User-agent: *
Allow: /
`;
}

export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="var(--favicon-bg, #111827)" />
  <path d="M9 11h14l-1.5 12H10.5L9 11Zm3-3a4 4 0 0 1 8 0" fill="none"
        stroke="#ffffff" stroke-width="2" stroke-linecap="round" />
</svg>
`;
}

export function readme(ctx: SiteContext): string {
  return `# ${ctx.config.storeName}

A static storefront generated from an AliExpress product listing.

## Run it locally

\`\`\`bash
npm install
npm run dev
\`\`\`

See \`DEVELOPMENT.md\` for where everything lives and how to change it.

## Build it

\`\`\`bash
npm run build
\`\`\`

The build writes plain HTML, CSS and JS to \`dist/\`. There is no server
component — deploy that folder anywhere.

## Deploy it

This store is yours. Deploy it to your own hosting account:

- **Vercel** — \`npx vercel deploy --prod\`, or connect the repo in the dashboard.
- **Netlify** — \`npx netlify deploy --prod --dir dist\`.
- **Anything else** — upload \`dist/\` to any static host or CDN.

## Before you take orders

${checkoutInstructions(ctx)}

## Product data

Everything the pages render comes from \`src/data/store.json\`. Edit that file to
change copy, pricing or images — the templates read it and never hardcode
product details.

Source listing: ${ctx.product.sourceUrl}
`;
}

/** Deploy-time instructions, which differ a lot by checkout mode. */
function checkoutInstructions(ctx: SiteContext): string {
  if (ctx.hasCheckoutApi) {
    return `This store has its own checkout endpoint at \`/api/checkout\`. It runs as a
serverless function on **your** hosting account and creates a Stripe Checkout
Session per order.

**Set your Stripe secret key in your hosting environment before going live:**

\`\`\`
STRIPE_SECRET_KEY=<your Stripe secret key>
\`\`\`

- Vercel: Project → Settings → Environment Variables
- Netlify: Site configuration → Environment variables

The key is read only by your own function. It is not in this repository, and the
app that generated this store never had it. Prices are read from
\`src/data/store.json\` on the server, never from the browser, so a tampered
request can't change what anything costs.

Until the key is set, checkout returns a 503 and the store explains that
checkout isn't configured.`;
  }

  if (ctx.config.checkout.provider === "waitlist") {
    return `This store captures a **waitlist** rather than taking payment. The form posts
to the endpoint configured when it was generated, or falls back to your support
email.

To take payment instead, upgrade to premium and regenerate the store.`;
  }

  if (ctx.config.checkout.paymentLinkUrl) {
    return `Checkout uses a **Stripe Payment Link** created against your account when this
store was generated. It works as-is — no environment variables needed.

Payment links carry one line item, so the cart checks out the first item. If you
want a true multi-item cart, regenerate the store targeting Vercel or Netlify to
get the \`/api/checkout\` endpoint instead.`;
  }

  return `**No payment provider is wired up.** Connect your own (Stripe, PayPal, Shopify
Buy Button, etc.) before pointing real traffic at this store.`;
}
