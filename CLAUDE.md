# Project: [Name TBD] — Dropshipping Store Validator

## What this is
A desktop app (Electron) that lets a user paste an AliExpress product link and get a
fully working dropshipping storefront (Astro static site) they can deploy themselves,
for the purpose of fast product/market validation — not a hosted SaaS storefront platform.

We are the tool that *builds* the store. We are explicitly **not** the host, the CDN,
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
  /desktop        Electron app (main + renderer)
  /landing        Marketing landing page — separate deploy, own repo/package.json
/packages
  /api            Hono routes: user/premium management, licensing, store-gen orchestration
  /store-generator Logic that takes an AliExpress URL -> scraped product data -> Astro site
  /db             SQLite schema, migrations, backup logic
  /shared         Shared types (product data, user/session, store config)
```
If the actual repo diverges from this, update this section first — don't let it drift
out of sync with reality.

## Feature scope (for reference — check off as built)
- [ ] Landing page — separate deploy, marketing site, own build/pipeline from the app
- [ ] Premium user management API (Hono) — auth, subscription status, licensing checks
- [ ] Store generator — AliExpress product link → scraped data → Astro dropshipping site
- [ ] SQLite storage, per-user, with backup for premium tier
- [ ] BYOK OpenRouter key management (encrypted at rest, validated on save)
- [ ] Deploy integration — Vercel/Netlify OAuth or token-based deploy of generated Astro site
- [ ] Marketing plan + materials (copy, positioning, launch assets — content work, not code)

## Data & backups
- Each user's data lives in a local SQLite file.
- Premium users get automated backup (destination TBD — likely user's own cloud
  storage or a lightweight object store we do pay for, since this is small structured
  data, not media — confirm before assuming we host it for them).
- Never assume a backup destination without checking this file for the decision once made.

## AliExpress scraping
- No official API — expect to build/maintain a scraper or use a third-party product-data
  API. This is fragile by nature: wrap it defensively, fail with a clear user-facing
  error ("couldn't read that product page") rather than a silent broken store, and
  isolate scraping logic in `packages/store-generator` so breakage doesn't cascade.
- Don't hardcode assumptions about AliExpress page structure deep into the generator —
  keep the scrape → normalized-product-data step separate from data → Astro-site step.

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
- Payment processing for the *end customers* of generated stores (that's a much bigger
  scope than product validation — confirm before ever starting this).
