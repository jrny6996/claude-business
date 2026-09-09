import { STORE_NODE_VERSION } from "@repo/shared";
import type { SiteContext } from "../context.js";

/**
 * The files that make a generated store a project someone can work in.
 *
 * A storefront is not much use as a black box: the whole promise is that the
 * user owns it, edits it and deploys it themselves. These files are what turn
 * the output directory into something an editor and a terminal understand.
 */

export function nvmrc(): string {
  return `${STORE_NODE_VERSION}\n`;
}

export function editorconfig(): string {
  return `root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
`;
}

/**
 * `.env.example`, committed — never `.env`, which is gitignored.
 *
 * The real key only ever exists in two places the user controls: this file's
 * uncommitted sibling on their own machine, and their hosting provider's
 * environment. It is never written into generated output, which a test in
 * `generate.test.ts` enforces.
 */
export function envExample(ctx: SiteContext): string {
  if (!ctx.hasCheckoutApi) {
    return `# This store has no server-side checkout, so it needs no secrets to run.
#
# Everything it renders comes from src/data/store.json. If you add your own
# integrations later, put their keys here and copy this file to .env.
`;
  }

  return `# Copy to .env for local development. .env is gitignored — never commit it.
#
# The checkout endpoint at src/pages/api/checkout.ts reads this key at request
# time. Use a TEST key locally; set the live key in your hosting provider's
# environment variables (Vercel: Project → Settings → Environment Variables;
# Netlify: Site configuration → Environment variables).
#
# Prices are read server-side from src/data/store.json, never from the browser,
# so a tampered request can't change what anything costs.
#
# Left blank deliberately: no generated file in this project contains anything
# shaped like a Stripe key, so nothing here can ever be mistaken for a real one.
STRIPE_SECRET_KEY=
`;
}

export function developmentMd(ctx: SiteContext): string {
  return `# Working on ${ctx.config.storeName}

This is a plain [Astro](https://astro.build) project. Nothing about it is
locked to the app that generated it — it is yours to edit, host and keep.

## Requirements

- Node ${STORE_NODE_VERSION} or newer (\`.nvmrc\` pins it; run \`nvm use\` if you use nvm)
- npm 10 or newer

## First run

\`\`\`bash
npm install
${ctx.hasCheckoutApi ? "cp .env.example .env   # then paste your Stripe TEST key\n" : ""}npm run dev
\`\`\`

The dev server prints a local URL. Edits reload in place.

> If you generated this store with the desktop app and previewed it there, the
> app linked a shared Astro runtime in as \`node_modules\` so the preview could
> start without a per-store install. That link is not portable. Running
> \`npm install\` here replaces it with a real install that travels with the
> folder — do that before you move this project anywhere.

## Scripts

| Command | What it does |
| ------- | ------------ |
| \`npm run dev\` | Dev server with hot reload |
| \`npm run build\` | Production build into \`dist/\` |
| \`npm run preview\` | Serve the built output locally |

## Where things live

| Path | What it is |
| ---- | ---------- |
| \`src/data/store.json\` | **All** product and store data. Edit copy, prices and images here. |
| \`src/styles/theme.css\` | Theme tokens — accent colour, fonts, preset. |
| \`src/styles/global.css\` | Layout and component styles. |
| \`src/pages/index.astro\` | The product page. |
| \`src/components/\` | Header, footer, gallery, rating, buy box. |
${ctx.hasCheckoutApi ? "| `src/pages/api/checkout.ts` | Serverless checkout endpoint. Runs on your host. |\n" : ""}
The templates never hardcode product details — they read \`store.json\`. Changing
a price there changes it everywhere, including${
    ctx.hasCheckoutApi ? " the amount charged at checkout" : " the display price"
  }.

## Deploying

See \`README.md\`. Short version: \`npm run build\`, then deploy with your own
host's CLI or Git integration.
`;
}
