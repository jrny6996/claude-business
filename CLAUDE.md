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

- **BYOK for AI** — users supply their own key for **OpenRouter or Google Gemini**
  (`packages/store-generator/src/ai/`); we store it encrypted, never proxy inference
  through a key of ours, and every AI-powered feature (product description rewrite,
  image alt text) degrades to a warning naming the selected provider if no key is set.
  Adding a provider is one file implementing `AiClient` plus one case in
  `createAiClient` — nothing above that line knows which provider is in use.
- **BYO hosting** — generated stores are plain Astro projects the user deploys to their
  own Vercel/Netlify account (OAuth or manual deploy token). We do not run a
  reverse proxy or host their storefront traffic.

If a task description implies server-side image processing, video transcoding, or an
AI call billed to us, stop and flag it rather than implementing it.

**One deliberate exception exists**, decided explicitly by the product owner:
hosted **backup** storage, as a paid opt-in alongside the local folder. We pay
for that storage. It is bounded by the fact that the data is encrypted on the
user's machine with a key we never receive, so we cannot read what we store —
see Data & backups. That exception covers backups and nothing else: it is not a
precedent for hosting storefronts, images, or inference.

## Checkout and tiers

**Decided (explicitly, by the product owner): checkout is the premium
feature.** This is the pricing decision this file said to checkpoint on, so it
is recorded here rather than inferred.

- **Free** — the buy button is a **waitlist capture**. For validation this is
  arguably the better signal anyway: you learn whether people want it before
  you stock anything.
- **Premium** — Stripe checkout, created against the user's own account.

The gate lives in exactly one place: `resolveCheckout` in
`packages/api/src/services/stores.ts`. Both create and regenerate go through it,
so a regenerate can never quietly move a store between tiers. A free user who
has saved a Stripe key still gets a waitlist — the key is theirs, but _taking
payment_ is the thing being sold.

### How Stripe checkout works (premium)

Two modes, chosen by where the store is deployed.

**`api` (default, Vercel/Netlify).** The store ships its own REST endpoint at
`src/pages/api/checkout.ts`, which runs as a serverless function **on the user's
hosting account** and creates a Stripe Checkout Session per order.

- The Stripe secret key lives in _their_ host's environment as
  `STRIPE_SECRET_KEY`. In this mode our app never needs the key at all, and makes
  no Stripe call at generation time.
- **Prices are read from the store's own `store.json` on the server, never from
  the request.** The browser may send a variant id and a quantity and nothing
  else. Verified by intercepting the outbound call: a request claiming
  `unitAmount: 1` and `name: "FREE WATCH"` still sent `unit_amount=13908` and the
  catalogue's own product name. A test asserts the request interface carries no
  money field — do not add one.
- **No generated file contains anything shaped like a Stripe key**, including
  documentation placeholders — `.env.example` leaves `STRIPE_SECRET_KEY=` blank
  and the README says `<your Stripe secret key>`. The test asserting this runs
  over both a static and an API-mode store, because only the latter emits the
  files that talk about the key.
- Supports a real multi-item cart and any number of variants.
- The route must keep `export const prerender = false`, and the project needs the
  matching adapter (`@astrojs/vercel` / `@astrojs/netlify`).

**`payment_link` (static hosts).** Links pre-created at generation time from the
user's key held in the app. One line item per link, variant links capped at 20. A
static host has nowhere to run a function, so `resolveCheckout` forces this mode
and warns.

Either way checkout happens on **Stripe's** hosted page. No money and no card
data touches us, and we take no cut. A test asserts `sk_live`/`sk_test` never
appears in generated output.

### How the waitlist works (free)

- The form posts to a **user-supplied endpoint** (their Formspree, Buttondown,
  own webhook), falling back to `mailto:` their support address so the button is
  never dead. A static store has nowhere to keep emails and we are not a
  backend — the addresses go to them, never to us.
- A waitlist store renders **no cart and no cart nav link**. A store that cannot
  take an order must not imply that it can.

### Licensing

Entitlement comes from an **Ed25519-signed licence key**, verified offline
against a public key embedded at build time (`DSV_LICENSE_PUBLIC_KEY`). This
replaced an earlier version that believed whatever tier the client claimed.

- The stored key is **re-verified on every read**, not trusted from a database
  column, so an expired licence downgrades on its own with no stale-premium
  state to go wrong.
- `packages/api/src/services/license-keys.ts` splits verify (public key, ships
  to users) from sign (private key, issuer only). Nothing on a user's machine
  can mint a licence. Tests prove forged, tampered and expired keys are refused.
- Mint keys with `node scripts/issue-license.mjs --email … --tier premium`.
  `--generate-keypair` creates an issuer pair. The dev private key is
  gitignored; the production key must never be in the repo.
- Still open, and deliberately not guessed: **the price of premium**, and where
  the issuer runs / which payment webhook drives it. The landing page shows no
  number on purpose.

## Product assets

Generated stores **download their product images** rather than hotlinking
`ae01.alicdn.com`. A store that hotlinks a marketplace CDN is not one the user
owns: the URLs rot when a listing changes, AliExpress can block them, and every
visitor to the user's shop hits a site the user doesn't control.

This costs us nothing by construction — the download runs on the user's machine
and the bytes land in their project, on their way to their own host. It is the
same rule as everything else here, applied to images.

- `packages/store-generator/src/assets/` — `download.ts` is the pure part
  (naming, sniffing, guards), `index.ts` writes to `public/images/`.
- **Bytes decide the extension, not the URL.** AliExpress serves AVIF behind
  `.jpg` addresses; trusting the URL gives the user a gallery their browser
  won't decode. Magic-byte sniff first, then `content-type`, then the URL.
- Names are **positional** (`product-01.jpg`), never derived from the source
  filename — those are opaque hashes and would put marketplace identifiers into
  the user's repository.
- **Partial success is normal.** An image that won't download keeps its remote
  URL and becomes a warning; one dead CDN link must not cost someone their store.
- Guards: `http(s)` only (a scraped page is untrusted input), 8MB per image, 16
  images per store, and every path re-checked against the output directory.
- `ProductImage.url` therefore accepts an absolute URL **or** a root-relative
  path (`ImageSrcSchema` in `packages/shared/src/product.ts`).

## Per-store dev environment

`Stores → Dev environment` runs a real `npm install` in the store's own folder.

The store the preview runs is **not a project anyone can open**: its
`node_modules` is a symlink to our shared Astro runtime, which resolves only on
that machine while the app is installed. Everything the README tells the user to
do next — open it in an editor, commit it, copy it to a build machine — assumes a
real install.

- Pure parts (command building, npm output parsing) in
  `packages/store-generator/src/dev-env.ts`; spawning in
  `apps/desktop/electron/dev-env.ts`.
- **The symlink must be removed before installing.** npm would otherwise follow
  it and install into the *shared* runtime, corrupting the preview for every
  other store. `rm` on a symlink removes the link, never the target — there is a
  test for exactly that.
- `npm install`, never `npm ci`: a generated store ships no lockfile.
- We **do not bundle a Node toolchain.** If npm isn't on the user's machine we
  say so and print the command. A GUI-launched app inherits a minimal PATH, so
  the usual Node locations are probed explicitly.
- The preview prefers the store's own `astro` once it has one, so after setup the
  preview runs exactly what the user's `npm run dev` would.
- Generated stores ship `.nvmrc`, `.editorconfig`, `.env.example` and
  `DEVELOPMENT.md`; `.gitignore` excludes `.env` and keeps `.env.example`.
- **`@repo/desktop` depends on `astro` and both adapters** — that is the shared
  preview runtime. Without the adapters, previewing a premium Vercel/Netlify
  store fails with `Cannot find module '@astrojs/vercel'`. Keep those versions
  matching what `generate/templates/project.ts` pins into the store.

## Store preview

`Stores → Preview` runs the generated store's **own Astro dev server** and
frames it, so the preview is the real site and cannot drift from what deploys.

- Astro needs a `node_modules` it can resolve `astro/config` from, and a
  generated store has none. Rather than installing ~190 packages per store, one
  shared runtime is **symlinked in** as the store's `node_modules` (a junction
  on Windows). A store copied elsewhere to deploy just runs `npm install`, as
  its README says.
- `astro dev` **daemonises** in Astro 7: it prints the URL and pid, exits 0, and
  is stopped with `astro dev stop`. There is no long-lived child to babysit —
  but the daemon _will_ outlive the app if `stopAll()` isn't called on quit.
- Theme edits rewrite only `src/styles/theme.css` and `src/data/store.json`, so
  HMR updates the frame instead of restarting the server. Checkout is
  deliberately untouched by a theme change.
- Pure parts (command building, output parsing) are in
  `packages/store-generator/src/preview.ts` and unit-tested; process spawning is
  in `apps/desktop/electron/preview-server.ts`.
- The renderer's CSP needs `frame-src http://127.0.0.1:* http://localhost:*`.

Themes are five presets (`minimal`, `bold`, `editorial`, `warm`, `noir`) plus an
accent colour and font stack, in
`packages/store-generator/src/generate/templates/styles.ts`.

## Packaging and downloads

`npm run package --workspace @repo/desktop` builds installers via
electron-builder into `apps/desktop/release`; `package:dir` produces an unpacked
build, which is enough to check the config without signing.

- `executableName` and `artifactName` are pinned in `electron-builder.yml`
  because **the landing page links to those exact filenames**
  (`apps/landing/src/components/Download.astro`). Change one, change the other,
  or downloads 404. Without `executableName` the binary is named after the npm
  package (`@repodesktop`).
- `better-sqlite3` is `asarUnpack`ed and rebuilt against Electron by the builder.
- Builds are unsigned; signing is a release-time decision (Apple identity /
  Windows cert), and the landing page says so rather than letting users hit a
  scary dialog unwarned.
- `PUBLIC_RELEASE_BASE` and `PUBLIC_APP_VERSION` configure the landing page's
  links (`apps/landing/.env.example`).

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
- **AI**: OpenRouter or Google Gemini, BYOK, called directly from the user's machine
  — never proxied through our infrastructure. The provider is a user preference
  (`ai.provider`), independent of which keys are stored, so switching never touches a
  key. `resolveAiCredentials` in `packages/api/src/services/settings.ts` is the single
  place a credential is chosen.

## Repo structure (adjust as it solidifies, keep this section current)

```
/apps
  /desktop        Electron app: electron/ (main + sandboxed preload), src/ (React renderer)
  /landing        Astro marketing site — separate deploy, own package.json
/packages
  /api            Hono routes + services: settings/BYOK, licensing, store-gen orchestration, deploy
  /store-generator scrape/ (URL -> normalized product), generate/ (product -> Astro site),
                  stripe/ (BYOK payment links), ai/ (BYOK OpenRouter + Gemini),
                  assets/ (download product images into the store), dev-env.ts
  /db             SQLite schema, migrations, repositories, secret encryption, backup
  /cloud          Hono service we host: licence issuance (Stripe webhook) and
                  encrypted backup storage. Deployed with the landing page.
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
- [x] BYOK AI key management — OpenRouter and Google Gemini, encrypted at rest,
      validated on save, provider chosen independently of which keys exist
- [x] Asset bundling — product images downloaded into the generated store
- [x] Per-store dev environment — real `npm install`, `.env.example`, `DEVELOPMENT.md`
- [x] BYOK Stripe checkout — generation-time payment links (see Checkout below)
- [x] Deploy integration — token-based deploy instructions for Vercel/Netlify
      (we emit the command; the host's own CLI does the upload)
- [x] Marketing copy on the landing page — positioning, BYOK/BYO-hosting framing
- [x] Hosted licensing service — Stripe subscription → signed licence, in `packages/cloud`
- [x] Hosted encrypted backup — paid opt-in alongside the local folder
- [ ] Pricing decision — set `PREMIUM_PRICE_ID` in Stripe; no code change needed

## Data & backups

- Each user's data lives in a local SQLite file.
- Premium users get automated backup to **a directory the user picks** — their own
  disk, or a cloud folder they already sync. Implemented in
  `packages/db/src/backup.ts` via SQLite's online backup API (consistent snapshot
  under WAL, which a plain file copy would not give), with retention pruning.
  This remains the default.
- **Decided (explicitly, by the product owner, reversing the earlier position):
  hosted backup exists, as a paid opt-in _alongside_ the local folder.** We do
  now pay to store user data. That is a real, deliberate exception to the core
  principle above, and it is bounded by one property that must never be traded
  away:

  > **The backup is encrypted on the user's machine, with a key the service
  > never receives.** We store ciphertext and a length. A total breach of that
  > bucket leaks the sizes and timestamps of some backups and nothing else.

  If that property ever stops holding, this feature stops being defensible —
  it becomes us holding other people's business data in the clear, at our own
  expense and our own risk. Do not add a server-side path that decrypts, and do
  not "helpfully" upload the key.

- `backup.destination` is `local` (default), `cloud`, or `both`. `both` is what
  most people should pick: a hosted copy is only a backup if the local one can
  also fail. One destination failing never cancels the other.
- The encryption key is the user's, in `packages/db/src/backup-crypto.ts`. It is
  **not** the keychain-backed `SecretCipher` — a backup has to be restorable on a
  machine whose keychain has never seen this user, which is the exact situation
  backups exist for. It is surfaced as a written-down **recovery key** over an
  alphabet with no `0`/`O`/`1`/`I`/`L`, and a mistyped character is reported by
  name rather than silently dropped (a silently-dropped character decodes to a
  different valid-looking key and fails much later as "couldn't decrypt").
- **Restores are staged, not applied in place.** `restoreCloudBackup` writes
  `pending-restore.sqlite` beside the live database; `adoptPendingRestore` in
  `apps/desktop/electron/main.ts` swaps it in at next boot, before any connection
  is opened, and renames the previous database and its WAL/shm rather than
  deleting them. Swapping a database under a running app is how you corrupt
  someone's data while trying to rescue it.
- Quotas and retention live server-side (`packages/cloud/src/services/backups.ts`):
  ten backups per account, 250MB, 5MB per upload. The upload cap must stay under
  the platform's own request-body limit — Netlify's synchronous functions stop at
  6MB.

## The hosted service

`packages/cloud` is the **only** part of this product that runs on our
infrastructure and costs us money. It is deliberately small, and it does exactly
two things: issue licences, and store backups it cannot read.

It deploys with the marketing site (`apps/landing`) as a single Netlify Function
at `netlify/functions/api.mts`, which mounts the Hono app — the same
`app.fetch(request)` arrangement the desktop app uses, so the whole service is
testable with no platform in the picture. Every marketing page stays prerendered.

- **No Astro adapter, on purpose.** `@astrojs/netlify` pulls Netlify's function
  bundler in at config-load time, and that chain reads TypeScript's classic
  `ts.TypeFlags` via `ts-api-utils` — which the native TypeScript 7 compiler this
  repo builds with does not expose, so `astro build` dies before it starts.
  Netlify bundles the function itself at deploy time, so nothing is lost.
  (npm `overrides` were tried and are silently ignored in this workspace.)
- **The licence signing key exists only here**, in `DSV_LICENSE_PRIVATE_KEY`.
  `packages/api/src/services/license-keys.ts` ships only the verify half.
- **The price of premium is not in the codebase.** It is a Stripe Price named by
  `PREMIUM_PRICE_ID`; `/api/checkout/price` reads it back so the landing page can
  show a real figure. With none configured the page says premium isn't on sale —
  never a guessed number.
- **Sold as an annual subscription.** `invoice.paid` re-issues; the licence id is
  derived from the Stripe subscription id so it is *stable across renewals* — the
  storage namespace is derived from it, and a changing id would orphan a
  subscriber's backups once a year. Cancellation is deliberately a no-op: the
  outstanding licence already expires at period end, and revoking early would
  take back a period the customer paid for.
- **Webhook signatures are verified against the raw body.** Parsing the JSON and
  re-serialising it changes bytes and breaks verification — the route reads
  `c.req.text()` and never `c.req.json()`. Comparison is timing-safe, with a
  timestamp tolerance so captured requests can't be replayed.
- **No customer database.** Stripe already has one; a second would be another
  thing to secure, sync and delete on request. Licence recovery re-mints from the
  live subscription, and answers identically for an address that never bought
  anything — otherwise it is an oracle for "does this person use the product".
- Blob keys are `backups/<sha256(licence id)>/<uuid>`: no email address and no
  key material appears in storage listings, logs or the provider's dashboard.

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
- Being in the payment path for **our users' customers**. End-customer checkout is
  in scope strictly as BYOK Stripe: their key, their account, Stripe's hosted page.
  We take no platform fee, hold no card data, and never proxy a payment. Selling
  our own subscription through our own Stripe account is a separate thing and is
  in scope — see The hosted service.
- Storing user data we can read. Hosted backup exists, but only because it is
  sealed on the user's machine first. A server-side decrypt path is out of scope.
