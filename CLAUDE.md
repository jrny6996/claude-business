# Project: [Name TBD] — Dropshipping Store Validator

## What this is

A desktop app (Electron) that lets a user paste an AliExpress product link and get a
fully working dropshipping storefront (Astro static site) they can deploy themselves,
for the purpose of fast product/market validation — not a hosted SaaS storefront platform.

We are the tool that _builds_ the store. We are explicitly **not** the host, the CDN,
or the AI compute provider for that store. Keep that line sharp in every decision below.

## Core principle (read this before touching pricing, infra, or API design)

**We do not pay for media hosting or AI inference on behalf of users.** This is not a
future optimization — it's the business model. Any feature that would route images,
video, or LLM calls through our servers and bill it to us is out of scope unless
explicitly discussed. Two mechanisms enforce this:

- **BYOK for OpenRouter** — users supply their own OpenRouter API key; we store it
  encrypted, never proxy inference through a key of ours, and every AI-powered feature
  (product description rewrite, image alt text, etc.) fails gracefully with a clear
  "add your OpenRouter key" prompt if none is set.
- **BYO hosting** — generated stores are plain Astro projects the user deploys to their
  own Vercel/Netlify account (OAuth or manual deploy token). We do not run a
  reverse proxy or host their storefront traffic.

If a task description implies server-side image processing, video transcoding, or an
AI call billed to us, stop and flag it rather than implementing it.

## Checkout (BYOK Stripe)

Every generated store gets Stripe checkout, and the user brings their own keys.
The mechanism matters, because a static site cannot hold a Stripe secret key:

- At **generation time**, the desktop app calls Stripe directly from the user's
  machine with the user's own secret key and creates a Product, a Price and a
  **Payment Link** (plus one extra Price/Link per available variant that is priced
  differently from the base, capped at 20).
- Only the resulting `https://buy.stripe.com/...` URL is written into the store.
  Grep the generated output for `sk_live`/`sk_test` — there is a test asserting it
  never appears.
- Checkout therefore happens on **Stripe's** hosted page, not on the generated
  store and not on anything we run. Quantity is adjustable there.
- No Stripe key set? The store still generates, `checkout.provider` degrades to
  `"none"`, the buy button renders disabled with an explanatory note, and the
  create call returns a `MISSING_STRIPE_KEY` warning. Same graceful-degradation
  contract as OpenRouter.
- If someone later asks for a real server-side Checkout Session, that needs a
  serverless function and a per-host Astro adapter. Flag it rather than adding it
  quietly — it changes the deploy story.

## Design system

`packages/design-system` holds the **Modernist** system vendored from the Claude
Design project "App and landing page design". It dresses `apps/desktop` and
`apps/landing` only. Generated storefronts deliberately use a _separate_,
user-themeable token set in
`packages/store-generator/src/generate/templates/styles.ts` — the store owner picks
their accent colour and preset, so our brand must not leak into their shop.
Re-pull with `DesignSync` rather than hand-editing `styles.css`. The house rules
that are easiest to break: zero corner radius, flush-left everything (including
labels in wide buttons), strong 2px dividers, accent used sparingly, photographs
through `.grayscale`, and never hard-code a value the tokens already carry.

## Tech stack

- **Shell**: Electron (main + renderer), TypeScript throughout.
- **API layer**: Hono — used both for the local Electron-embedded server (premium user
  management, store generation orchestration) and, where relevant, as the pattern for
  any edge/serverless functions we do run ourselves (auth, licensing — NOT storefront
  traffic).
- **Data**: SQLite per user (better-sqlite3 or libsql), file-based, with an opt-in
  backup mechanism for premium users (see Data & backups below).
- **Generated storefronts**: Astro, static output, deployed by the user to their own
  Vercel/Netlify. Treat the Astro site as a build artifact our tool produces, not
  something our runtime serves.
- **AI**: OpenRouter only, BYOK, called directly from the user's machine/deploy — never
  proxied through our infrastructure.

## Repo structure (adjust as it solidifies, keep this section current)

```
/apps
  /desktop        Electron app: electron/ (main + sandboxed preload), src/ (React renderer)
  /landing        Astro marketing site — separate deploy, own package.json
/packages
  /api            Hono routes + services: settings/BYOK, licensing, store-gen orchestration, deploy
  /store-generator scrape/ (URL -> normalized product), generate/ (product -> Astro site),
                  stripe/ (BYOK payment links), ai/ (BYOK OpenRouter)
  /db             SQLite schema, migrations, repositories, secret encryption, backup
  /shared         Zod schemas + types (product, store config, settings, Result/AppError)
  /design-system  Modernist tokens + component CSS, vendored from Claude Design.
                  Dresses the app and landing page only — NOT generated storefronts.
  /eslint-config  Shared flat ESLint config (lints .js/.mjs/.ts/.tsx)
  /typescript-config Shared tsconfig bases
```

If the actual repo diverges from this, update this section first — don't let it drift
out of sync with reality.

## Feature scope (for reference — check off as built)

- [x] Landing page — separate deploy, marketing site, own build/pipeline from the app
- [x] Premium user management API (Hono) — subscription status, licensing checks
      (local entitlement only; signed-licence verification still open — see below)
- [x] Store generator — AliExpress product link → scraped data → Astro dropshipping site
- [x] SQLite storage, per-user, with backup for premium tier
- [x] BYOK OpenRouter key management (encrypted at rest, validated on save)
- [x] BYOK Stripe checkout — generation-time payment links (see Checkout below)
- [x] Deploy integration — token-based deploy instructions for Vercel/Netlify
      (we emit the command; the host's own CLI does the upload)
- [x] Marketing copy on the landing page — positioning, BYOK/BYO-hosting framing
- [ ] Pricing decision — the landing page is deliberately number-free until it's made

## Data & backups

- Each user's data lives in a local SQLite file.
- Premium users get automated backup. **Decided: the destination is a directory the
  user picks** — their own disk, or a cloud folder they already sync. We do not
  upload it anywhere. This was the conservative reading of the TBD: defaulting to
  our own storage would have quietly made us pay for user data. Implemented in
  `packages/db/src/backup.ts` via SQLite's online backup API (consistent snapshot
  under WAL, which a plain file copy would not give), with retention pruning.
- If a hosted destination is ever agreed, add it as an explicit opt-in _alongside_
  this, not as a replacement.

## AliExpress scraping

**Verified against the live site, September 2026 — do not "simplify" this back
to an HTTP fetch.** Three things are true and each one broke a naive scraper:

1. **Product pages render client-side.** The HTML AliExpress serves has an empty
   `<title>`, empty OpenGraph tags, no JSON-LD and no price anywhere. There is
   nothing for an HTTP scraper to read. Product data only exists after the page's
   JavaScript runs.
2. **Non-browser clients get an anti-bot wall.** Requests land on
   `/_____tmd_____/punish?x5secdata=…`. It is intermittent and IP-dependent.
3. **A plain client with no cookie jar hits a redirect loop.** `aliexpress.com`
   redirects to the regional gateway, which bounces through
   `sync_cookie_read` → `sync_cookie_write`; drop the cookie you were just given
   and you ping-pong until the redirect budget runs out. This previously surfaced
   as "check your connection", which was actively misleading.

So pages are loaded in a **real Chromium window** (`apps/desktop/electron/browser-source.ts`)
and we read the page state the storefront itself uses. The layering is unchanged:
a `PageSource` yields `{ html, pageData?, domProduct? }`, and `scrape/normalize.ts`
turns that into `NormalizedProduct`. `packages/store-generator` still has zero
Electron dependency, and tests inject a fake `PageSource`.

**On the bot wall: we do not try to defeat it.** No fingerprint spoofing, no
proxy rotation, no captcha-solving service. When a challenge is detected the
window is _shown_ and the user clears it themselves, in their own session on
their own IP. Cookies live in a `persist:aliexpress` partition so a check
cleared once keeps working. The UA is set to plain Chrome only because
Electron's default advertises `Electron/<version>` — it is a real Chromium
either way. Whether scraping a given listing is allowed is the user's call.

Non-obvious things that cost real debugging time:

- After a human clears the check, **AliExpress does not navigate back to the
  listing.** You must re-load the target URL yourself, or the poll watches a
  page that will never become a product.
- The challenge must be remembered _stickily_. By the time you give up, neither
  the URL nor the body still looks like a challenge, and the failure gets
  misreported as "this listing has no product on it".
- `document.visibilityState` is `"visible"` even for a `show: false` window, so
  hiding does not stop hydration. This was investigated and ruled out.
- Page state lives under `window.runParams`, `window._pdp_cache_` **or**
  `window._d_c_` depending on rollout, and sometimes only in the DOM. All four
  are tried, best-source-first, and merged.
- **PDP class names are content-hashed** — `price-default--current--F8OlYIo`,
  `reviewer--rating--xrWWFzx`. Match the stable middle segment
  (`[class*="price-default--current"]`), never a guessed prefix: an earlier
  version matched `price--current`, which silently matches nothing, so every
  scrape failed with "no product data" while the title was being read fine.
  `packages/store-generator/src/scrape/dom-product.test.ts` pins these against
  markup captured from a real listing — update it from a real page, not by
  guessing.
- Image URLs carry a resize suffix _and_ a format hint
  (`….jpg_220x220q75.jpg_.avif`); both come off to reach the original.
- Variant prices are not in the DOM (only the selected one renders), so
  DOM-derived variants inherit the headline price rather than inventing one.
- Anything injected into the page via `executeJavaScript` lives in a **template
  literal**: a regex written `/\s+/` there silently becomes `/s+/`. Write
  `/\\s+/`. ESLint's `no-useless-escape` catches this — don't silence it.
- The `.com` → `.us` gateway rewrites the item id. `sourceId` comes from the
  pasted URL, not the final one.
- Don't serialise the whole DOM on every poll tick — pages are ~75-90KB and the
  poll can run for minutes while a human works.

Keep failures legible: a challenge is `BOT_CHALLENGE`, an abandoned window is
`CHALLENGE_ABANDONED`, genuinely changed markup is `PARSE_FAILED`. Reporting the
wrong one sends people hunting for a bug that isn't there.

## Coding conventions

- TypeScript strict mode everywhere.
- Hono routes: one file per resource, thin handlers, business logic in `packages/api`
  services, not inline in route handlers.
- SQLite access goes through `packages/db` — no raw queries scattered across the app.
- Env/secrets (OpenRouter keys, deploy tokens) are encrypted at rest client-side;
  never logged, never sent anywhere except directly to the service they're for.
- Prefer small, reviewable commits over large ones — this matters more than usual here
  since Claude Code will often be running with elevated autonomy (see below).

## Working autonomously on this repo

- Work on a branch per feature/task, open a PR rather than committing to main.
- Run the test suite and linter before considering a task done; don't wait for a human
  to ask for it.
- For anything touching pricing logic, BYOK key handling, or what gets billed to our
  infra vs. the user's — stop and flag for review rather than proceeding. This is the
  one category where autonomy should yield to a checkpoint, since it's the core
  business-model constraint above.
- Everything else (UI, store-generator logic, Hono routes, SQLite schema, Astro
  templates) is fair game to build end-to-end and present as a diff for review.

## Marketing workstream (content, not code)

Treat this as a separate track from app development, but keep it in the same repo
context so positioning stays consistent with what the product actually does:

- Core pitch: fast, cheap product validation — spin up a real dropshipping storefront
  from one link, no hosting/AI costs baked into our price because you bring your own.
- Target audience: solo/small dropshipping operators and validators, likely
  price-sensitive and technical-enough to handle a Vercel/Netlify deploy.
- Materials needed: landing page copy, a short explainer of the BYOK/BYO-hosting model
  (this is a differentiator, not a limitation — frame it that way), launch posts.

## Non-goals (explicitly out of scope unless this file changes)

- Hosting generated storefronts ourselves.
- Proxying or subsidizing AI inference calls.
- Building a general-purpose e-commerce platform beyond the validation use case.
- Being in the payment path ourselves. End-customer checkout **is** in scope as of
  the Checkout section below (confirmed explicitly, which is what this file asked
  for), but strictly as BYOK Stripe: their key, their account, Stripe's hosted
  page. We take no platform fee, hold no card data, and never proxy a payment.
