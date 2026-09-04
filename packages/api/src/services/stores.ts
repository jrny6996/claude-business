import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AppError,
  StoreConfigSchema,
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

  let finalConfig = config;

  if (input.enableCheckout !== false && config.checkout.provider === "stripe") {
    const secretKey = ctx.data.settings.readSecret("stripe_secret_key");
    if (!secretKey) {
      warnings.push({
        code: "MISSING_STRIPE_KEY",
        message:
          "Checkout is not connected — add your Stripe secret key in Settings and regenerate to enable payments.",
      });
      finalConfig = { ...config, checkout: { ...config.checkout, provider: "none" } };
    } else {
      try {
        const checkout = await provisionStripeCheckout(config, product, {
          secretKey,
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        });
        finalConfig = { ...config, checkout };
      } catch (cause) {
        warnings.push({
          code: cause instanceof AppError ? cause.code : "STRIPE_REQUEST_FAILED",
          message:
            cause instanceof AppError
              ? cause.message
              : "Couldn't set up Stripe checkout; the store was generated without payments.",
        });
        finalConfig = { ...config, checkout: { ...config.checkout, provider: "none" } };
      }
    }
  }

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

  let finalConfig = config;
  if (config.checkout.provider === "stripe" && !config.checkout.paymentLinkUrl) {
    const secretKey = ctx.data.settings.readSecret("stripe_secret_key");
    if (!secretKey) {
      warnings.push({
        code: "MISSING_STRIPE_KEY",
        message: "Checkout is still not connected — add your Stripe secret key.",
      });
      finalConfig = { ...config, checkout: { ...config.checkout, provider: "none" } };
    } else {
      const checkout = await provisionStripeCheckout(config, existing.product, {
        secretKey,
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      });
      finalConfig = { ...config, checkout };
    }
  }

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
