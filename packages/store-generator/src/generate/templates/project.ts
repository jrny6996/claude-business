import type { SiteContext } from "../context.js";

/** Astro version the generated storefront is pinned to. */
export const ASTRO_VERSION = "^7.3.1";

export function packageJson(ctx: SiteContext): string {
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
        dependencies: { astro: ASTRO_VERSION },
      },
      null,
      2,
    ) + "\n"
  );
}

export function astroConfig(): string {
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
  return `dist/
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

The checkout page is a stub. It collects an order intent and does nothing else:
**no payment provider is wired up**. Connect your own (Stripe, PayPal, Shopify
Buy Button, etc.) before pointing real traffic at this store.

## Product data

Everything the pages render comes from \`src/data/store.json\`. Edit that file to
change copy, pricing or images — the templates read it and never hardcode
product details.

Source listing: ${ctx.product.sourceUrl}
`;
}
