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
4. It downloads the product images and emits a plain **Astro** site with checkout
   wired in — a self-contained project with nothing pointing back at AliExpress.
5. You set up a dev environment for it, preview it live, and deploy it to your
   own Vercel/Netlify account.

## Layout

| Path                       | What lives there                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`             | Electron app. `electron/` is the main process + sandboxed preload; `src/` is the React renderer.                                      |
| `apps/landing`             | Astro marketing site, deployed separately.                                                                                            |
| `packages/shared`          | Zod schemas and types shared by everything: product, store config, settings, `Result`/`AppError`.                                     |
| `packages/db`              | SQLite: migrations, repositories, encrypted secret storage, premium backup. All DB access goes through here.                          |
| `packages/store-generator` | `scrape/` (URL → normalized product), `generate/` (product → Astro project), `assets/` (download images into the store), `stripe/` (BYOK payment links), `ai/` (BYOK OpenRouter + Gemini), `dev-env.ts`. |
| `packages/api`             | Hono routes + services. Runs in-process inside Electron.                                                                              |
| `packages/design-system`   | Modernist tokens/components for the app and landing page. Not used by generated stores.                                               |

## Tiers

|                             | Free                 | Premium             |
| --------------------------- | -------------------- | ------------------- |
| Store generation            | unlimited            | unlimited           |
| Live Astro preview + themes | yes                  | yes                 |
| Bundled product images      | yes                  | yes                 |
| AI copy + alt text (BYOK)   | yes                  | yes                 |
| Per-store dev environment   | yes                  | yes                 |
| Buy button                  | **waitlist capture** | **Stripe checkout** |
| Automated backups           | no                   | yes                 |

Free measures demand; premium takes payment. The waitlist posts to the store
owner's own form endpoint (falling back to `mailto:` their support address) —
we never receive the addresses. Premium is unlocked with an Ed25519-signed
licence key, verified offline.

Mint a key for local development:

```bash
node scripts/issue-license.mjs --generate-keypair          # once
node scripts/issue-license.mjs --email you@example.com --tier premium
```

Paste it into the app under **Settings → Licence**.

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
npm run test           # 326 tests
npm run check-types
npm run lint
```

Package installers:

```bash
npm run package --workspace @repo/desktop      # installers in apps/desktop/release
npm run package:dir --workspace @repo/desktop  # unpacked, no signing needed
```

> **Note:** if `NODE_ENV=production` is set in your shell, `npm install` will skip
> devDependencies and nothing will build. Install with
> `NODE_ENV=development npm install`.

## How the cost boundary is enforced

- **Stripe (BYOK).** Premium stores deployed to Vercel/Netlify ship their own
  `/api/checkout` endpoint, which runs as a serverless function on the user's
  hosting account with `STRIPE_SECRET_KEY` from that host's environment — the
  key never reaches this app at all. Prices are read server-side from the
  store's own data, never from the request. Static hosts fall back to Stripe
  Payment Links created at generation time. Either way checkout runs on Stripe's
  hosted page; we take no fee and see no card data, and a test asserts no
  `sk_live`/`sk_test` string ever appears in generated output.
- **AI (BYOK, two providers).** Copy rewriting and image alt text call
  **OpenRouter or Google Gemini** directly with the user's own key, billed to
  their account. The provider is a preference independent of which keys are
  stored, so switching never touches a key. Optional throughout: with no key set,
  or with the provider down, the store still generates and the API returns a
  warning instead of failing.
- **Images (BYO, by download).** Product images are downloaded onto the user's
  machine and written into their project, so the deployed store serves them from
  the user's own host. We never re-host or transcode an image — a store that
  hotlinks a marketplace CDN isn't one the user owns.
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
- **Preview is the real site.** `Stores → Preview` runs the generated store's
  own `astro dev` server and frames it, so it cannot drift from what deploys.
  Astro can't start without a resolvable `node_modules`, so one shared runtime
  is symlinked into each store rather than installed per store. `@repo/desktop`
  owns that runtime (`astro` plus both adapters) — the versions must match what
  the generator pins into each store.
- **The shared runtime is not the user's.** That symlink resolves only on this
  machine, inside this app. `Stores → Dev environment` replaces it with a real
  `npm install` the user owns, which is what makes the folder portable. The link
  is deleted before installing, or npm would follow it and install into the
  shared runtime — `rm` on a symlink removes the link, not the target.
- **Bundled images are project-relative.** After download, a `ProductImage.url`
  is `/images/product-01.jpg` rather than an absolute URL, which is why
  `ImageSrcSchema` accepts both.
- **The tier gate lives in one function.** `resolveCheckout` in
  `packages/api/src/services/stores.ts`; both create and regenerate route
  through it, so a regenerate can't move a store between tiers.
- **Licences are signed, not asserted.** Entitlement is an Ed25519 token
  re-verified on every read. Forged, tampered and expired keys are all refused,
  with tests for each.
- **Artifact names are pinned** in `electron-builder.yml` because the landing
  page links to those exact filenames. Change one, change the other.
