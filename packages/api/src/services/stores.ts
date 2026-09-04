import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AppError,
  StoreConfigSchema,
  ThemeSchema,
  type NormalizedProduct,
  type Store,
  type StoreConfig,
} from "@repo/shared";
import {
  defaultOutputDirName,
  generateAndWriteSite,
  provisionStripeCheckout,
  rewriteProductCopy,
  scrapeProduct,
} from "@repo/store-generator";
import { nowOf, type AppContext } from "../context.js";
import { effectiveTier } from "./settings.js";

export interface PreviewProductInput {
  url: string;
}

/**
 * Scrapes a pasted link without persisting anything.
 *
 * The UI calls this first so the user can see what we read off the page before
 * committing to a store — the cheapest possible way to catch a bad scrape.
 */
export async function previewProduct(
  ctx: AppContext,
  { url }: PreviewProductInput,
): Promise<NormalizedProduct> {
  return scrapeProduct(url, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.pageSource ? { pageSource: ctx.pageSource } : {}),
    now: nowOf(ctx),
  });
}

export interface CreateStoreInput {
  url: string;
  config: unknown;
  /** Rewrite the scraped copy with the user's own OpenRouter key. */
  useAiCopy?: boolean;
  /** Provision Stripe checkout with the user's own Stripe key. */
  enableCheckout?: boolean;
}

export interface CreateStoreResult {
  store: Store;
  /**
   * Non-fatal problems. Optional features (AI copy, Stripe checkout) degrade
   * into warnings rather than failing the whole generation, so a missing key
   * never costs the user their store.
   */
  warnings: { code: string; message: string }[];
}

/**
 * The main workflow: link in, deployable Astro project out.
 *
 * Ordering matters. We scrape first (most likely to fail), then persist a draft,
 * then run the optional enrichment steps, then write files. That way a failure
 * in an optional step leaves a recoverable draft rather than a half-written
 * directory.
 */
export async function createStore(
  ctx: AppContext,
  input: CreateStoreInput,
): Promise<CreateStoreResult> {
  const config = parseConfig(input.config);
  const warnings: CreateStoreResult["warnings"] = [];
  const now = nowOf(ctx);

  let product = await previewProduct(ctx, { url: input.url });

  const id = randomUUID();
  ctx.data.stores.create({ id, config, product }, now.toISOString());

  if (input.useAiCopy) {
    const apiKey = ctx.data.settings.readSecret("openrouter_api_key");
    if (!apiKey) {
      warnings.push({
        code: "MISSING_OPENROUTER_KEY",
        message:
          "Skipped the AI copy rewrite — add your OpenRouter key in Settings to use it.",
      });
    } else {
      try {
        const rewritten = await rewriteProductCopy(product, {
          apiKey,
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        });
        product = {
          ...product,
          description: rewritten.description,
          highlights:
            rewritten.highlights.length > 0
              ? rewritten.highlights
              : product.highlights,
        };
      } catch (cause) {
        warnings.push({
          code: cause instanceof AppError ? cause.code : "OPENROUTER_REQUEST_FAILED",
          message:
            cause instanceof AppError
              ? cause.message
              : "The AI copy rewrite failed; used the original description.",
        });
      }
    }
  }

  const { config: finalConfig } = await resolveCheckout(ctx, {
    config,
    product,
    wantsCheckout: input.enableCheckout !== false,
    warnings,
  });

  const outputDir = join(
    ctx.storesDir,
    `${defaultOutputDirName(finalConfig, product)}-${id.slice(0, 8)}`,
  );

  try {
    await generateAndWriteSite(finalConfig, product, outputDir, { now });
  } catch (cause) {
    ctx.data.stores.update(id, { status: "failed" }, now.toISOString());
    throw cause;
  }

  const store = ctx.data.stores.update(
    id,
    { config: finalConfig, status: "generated", outputDir },
    now.toISOString(),
  );
  if (!store) throw new AppError("INTERNAL", "The store vanished while generating.");

  return { store, warnings };
}

/** Rebuilds an existing store's files, picking up config or key changes. */
export async function regenerateStore(
  ctx: AppContext,
  id: string,
  configPatch?: unknown,
): Promise<CreateStoreResult> {
  const existing = requireStore(ctx, id);
  const now = nowOf(ctx);
  const warnings: CreateStoreResult["warnings"] = [];

  const config =
    configPatch === undefined ? existing.config : parseConfig(configPatch);

  // Same gate as creation: a regenerate must never quietly upgrade a free
  // store into one that takes money, or downgrade a paid one.
  const needsProvisioning =
    config.checkout.provider !== "stripe" || !config.checkout.paymentLinkUrl;
  const { config: finalConfig } = needsProvisioning
    ? await resolveCheckout(ctx, {
        config,
        product: existing.product,
        wantsCheckout: config.checkout.provider !== "none",
        warnings,
      })
    : { config };

  const outputDir =
    existing.outputDir ??
    join(ctx.storesDir, defaultOutputDirName(finalConfig, existing.product));

  await generateAndWriteSite(finalConfig, existing.product, outputDir, { now });

  const store = ctx.data.stores.update(
    id,
    { config: finalConfig, status: "generated", outputDir },
    now.toISOString(),
  );
  if (!store) throw new AppError("NOT_FOUND", "That store no longer exists.");

  return { store, warnings };
}

/**
 * Applies a theme to an already-generated store.
 *
 * Only the theme and the data island are rewritten, so an Astro dev server
 * watching the folder hot-reloads the preview instead of restarting. Checkout
 * is deliberately untouched: a theme change must not be able to move a store
 * between tiers.
 */
export async function updateStoreTheme(
  ctx: AppContext,
  id: string,
  theme: unknown,
): Promise<Store> {
  const existing = requireStore(ctx, id);
  const now = nowOf(ctx);

  const parsedTheme = ThemeSchema.safeParse(theme);
  if (!parsedTheme.success) {
    const first = parsedTheme.error.issues[0];
    throw new AppError(
      "VALIDATION_FAILED",
      first ? `theme.${first.path.join(".")}: ${first.message}` : "Invalid theme.",
    );
  }

  const config: StoreConfig = { ...existing.config, theme: parsedTheme.data };

  if (!existing.outputDir) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Generate the store before changing its theme.",
    );
  }

  await generateAndWriteSite(config, existing.product, existing.outputDir, { now });

  const updated = ctx.data.stores.update(id, { config }, now.toISOString());
  if (!updated) throw new AppError("NOT_FOUND", "That store no longer exists.");
  return updated;
}

export function listStores(ctx: AppContext): Store[] {
  return ctx.data.stores.list();
}

export function getStore(ctx: AppContext, id: string): Store {
  return requireStore(ctx, id);
}

export function deleteStore(ctx: AppContext, id: string): void {
  // Only the database row is removed. The generated directory is the user's
  // own project on their own disk — deleting their files is not ours to do.
  if (!ctx.data.stores.delete(id)) {
    throw new AppError("NOT_FOUND", "That store no longer exists.");
  }
}

function requireStore(ctx: AppContext, id: string): Store {
  const store = ctx.data.stores.findById(id);
  if (!store) throw new AppError("NOT_FOUND", "That store no longer exists.");
  return store;
}

function parseConfig(raw: unknown): StoreConfig {
  const parsed = StoreConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(
      "VALIDATION_FAILED",
      first ? `${first.path.join(".") || "config"}: ${first.message}` : "Invalid store settings.",
    );
  }
  return parsed.data;
}

/**
 * Decides what checkout a generated store gets.
 *
 * **This is the tier gate, and it is the only place it lives.** Taking payment
 * is a premium feature; free stores capture a waitlist instead, which for
 * product validation is arguably the better signal anyway. A free user who has
 * saved a Stripe key still gets a waitlist — the key is theirs, but the feature
 * is what is being sold.
 */
async function resolveCheckout(
  ctx: AppContext,
  {
    config,
    product,
    wantsCheckout,
    warnings,
  }: {
    config: StoreConfig;
    product: NormalizedProduct;
    wantsCheckout: boolean;
    warnings: CreateStoreResult["warnings"];
  },
): Promise<{ config: StoreConfig }> {
  const asWaitlist = (): { config: StoreConfig } => ({
    config: {
      ...config,
      checkout: { ...config.checkout, provider: "waitlist", paymentLinkUrl: null },
    },
  });

  if (!wantsCheckout || config.checkout.provider === "none") {
    return { config };
  }

  const tier = effectiveTier(
    ctx.data.users.ensureLocalUser().tier,
    ctx.data.users.ensureLocalUser().premiumUntil,
    nowOf(ctx),
  );

  if (tier !== "premium") {
    if (config.checkout.provider === "stripe") {
      warnings.push({
        code: "PREMIUM_REQUIRED",
        message:
          "Stripe checkout is a premium feature. This store captures a waitlist instead — upgrade and regenerate to take payments.",
      });
    }
    return asWaitlist();
  }

  if (config.checkout.provider !== "stripe") return { config };

  // API mode needs no Stripe call from us at all: the store's own endpoint
  // creates the session at request time using the key in the user's hosting
  // environment. That is strictly better — the secret never touches this app,
  // there's no per-variant link cap, and the cart can be multi-item.
  if (config.checkout.mode === "api") {
    if (config.deployTarget === "static") {
      warnings.push({
        code: "VALIDATION_FAILED",
        message:
          "A static host can't run a checkout endpoint. Pick Vercel or Netlify, or switch to payment links.",
      });
      return { config: { ...config, checkout: { ...config.checkout, mode: "payment_link" } } };
    }
    return { config };
  }

  const secretKey = ctx.data.settings.readSecret("stripe_secret_key");
  if (!secretKey) {
    warnings.push({
      code: "MISSING_STRIPE_KEY",
      message:
        "Add your Stripe secret key in Settings to take payments. This store captures a waitlist for now.",
    });
    return asWaitlist();
  }

  try {
    const checkout = await provisionStripeCheckout(config, product, {
      secretKey,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    return { config: { ...config, checkout } };
  } catch (cause) {
    warnings.push({
      code: cause instanceof AppError ? cause.code : "STRIPE_REQUEST_FAILED",
      message:
        cause instanceof AppError
          ? cause.message
          : "Couldn't set up Stripe checkout; the store captures a waitlist instead.",
    });
    return asWaitlist();
  }
}
