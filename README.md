# Store Validator

A desktop app that turns an AliExpress product link into a working dropshipping
storefront you deploy yourself — for fast product/market validation.

The point of the architecture is a cost boundary: **we build the store, we don't
run it.** No storefront hosting, no proxied AI inference, and no place in the
payment path. Users bring their own keys and their own hosting, and pay those
providers directly.

## What it does

1. Paste an AliExpress product URL.
2. It scrapes and normalizes the listing — title, images, price, variants, ratings.
3. You set a name, a look and a retail markup.
4. It emits a plain **Astro** static site with Stripe checkout wired in.
5. You deploy it to your own Vercel/Netlify account.

## Layout

| Path                       | What lives there                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`             | Electron app. `electron/` is the main process + sandboxed preload; `src/` is the React renderer.                                      |
| `apps/landing`             | Astro marketing site, deployed separately.                                                                                            |
| `packages/shared`          | Zod schemas and types shared by everything: product, store config, settings, `Result`/`AppError`.                                     |
| `packages/db`              | SQLite: migrations, repositories, encrypted secret storage, premium backup. All DB access goes through here.                          |
| `packages/store-generator` | `scrape/` (URL → normalized product), `generate/` (product → Astro project), `stripe/` (BYOK payment links), `ai/` (BYOK OpenRouter). |
| `packages/api`             | Hono routes + services. Runs in-process inside Electron.                                                                              |
| `packages/design-system`   | Modernist tokens/components for the app and landing page. Not used by generated stores.                                               |

## Running it

Requires Node >= 24.

```bash
npm install
npm run build          # all packages, both apps
npm run dev            # turbo dev
```

To run just the desktop app with hot reload:

```bash
npm run dev --workspace @repo/desktop
```

Checks:

```bash
npm run test           # 178 tests
npm run check-types
npm run lint
```

> **Note:** if `NODE_ENV=production` is set in your shell, `npm install` will skip
> devDependencies and nothing will build. Install with
> `NODE_ENV=development npm install`.

## How the cost boundary is enforced

- **Stripe (BYOK).** The app creates a Stripe Payment Link at generation time
  using the user's own secret key, on their machine. Only the resulting
  `buy.stripe.com` URL is written into the store — there is a test asserting no
  `sk_live`/`sk_test` string ever appears in generated output. Checkout runs on
  Stripe's hosted page. We take no fee and see no card data.
- **OpenRouter (BYOK).** AI copy rewriting calls OpenRouter directly with the
  user's key and is billed to their account. Optional: with no key set, the store
  still generates and the API returns a warning instead of failing.
- **Hosting (BYO).** Generated stores are static output. We emit the deploy
  command; the host's own CLI performs the upload. We never serve storefront
  traffic.
- **Secrets.** Encrypted at rest with the OS keychain via Electron `safeStorage`,
  falling back to an AES-256-GCM local key file where no secret service exists.
  Plaintext is never returned over IPC — the renderer only ever sees a `last4`
  hint.

## Design notes worth knowing before editing

- **Scraping is isolated on purpose.** Only
  `packages/store-generator/src/scrape/extract.ts` knows what an AliExpress page
  looks like. Everything downstream consumes `NormalizedProduct`. Extraction
  tries page-state JSON (`window.runParams`, both the `*Component` and older
  `*Module` key families), then JSON-LD, then OpenGraph, and merges them
  best-source-first.
- **Generated templates are constant strings.** All product data reaches the
  storefront through `src/data/store.json`, never through string interpolation.
  That is why a product title containing `"` or `<` can't corrupt the output —
  there's a test for exactly that.
- **Astro output is verified for real.** A generated store was built with the
  actual Astro toolchain (5 pages, correct marked-up prices, both Stripe links
  present), not just snapshot-tested.
