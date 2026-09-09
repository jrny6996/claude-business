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
  createAiClient,
  defaultOutputDirName,
  generateAndWriteSite,
  generateImageAltText,
  localiseProductAssets,
  provisionStripeCheckout,
  rewriteProductCopy,
  scrapeProduct,
  withGeneratedAltText,
} from "@repo/store-generator";
import { AI_PROVIDER_INFO } from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";
import {
  effectiveTier,
  getAiSettings,
  missingAiKeyCode,
  resolveAiCredentials,
} from "./settings.js";

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
  /** Rewrite the scraped copy with the user's own AI key. */
  useAiCopy?: boolean;
  /** Generate image alt text with the user's own AI key. */
  useAiAltText?: boolean;
  /**
   * Download the product images into the store instead of hotlinking the
   * marketplace CDN. On by default — a store that hotlinks isn't the user's.
   */
  bundleAssets?: boolean;
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

  product = await enrichWithAi(
    ctx,
    product,
    {
      copy: input.useAiCopy === true,
      altText: input.useAiAltText === true,
    },
    warnings,
  );

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

  const finalProduct = await bundleAssets(ctx, product, {
    outputDir,
    wanted: input.bundleAssets !== false,
    warnings,
  });

  try {
    await generateAndWriteSite(finalConfig, finalProduct, outputDir, { now });
  } catch (cause) {
    ctx.data.stores.update(id, { status: "failed" }, now.toISOString());
    throw cause;
  }

  // The enriched product is persisted, not the raw scrape: a regenerate must
  // rebuild what the user actually has, rewritten copy and local images and all.
  const store = ctx.data.stores.update(
    id,
    { config: finalConfig, product: finalProduct, status: "generated", outputDir },
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

  // Already-local images are skipped, so this is a no-op for a store whose
  // assets are bundled and a repair for one whose download previously failed.
  const finalProduct = await bundleAssets(ctx, existing.product, {
    outputDir,
    wanted: true,
    warnings,
  });

  await generateAndWriteSite(finalConfig, finalProduct, outputDir, { now });

  const store = ctx.data.stores.update(
    id,
    { config: finalConfig, product: finalProduct, status: "generated", outputDir },
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

/**
 * Optional AI enrichment, using whichever provider the user configured.
 *
 * Every failure here is a warning, never an error: a missing key, a rejected
 * key or a provider outage must still leave the user with a generated store.
 * That is also why the copy and alt-text steps are attempted independently —
 * one failing should not silently skip the other.
 *
 * The provider is the user's own, the key is read from their encrypted local
 * store at the moment of use, and the request leaves their machine directly.
 */
async function enrichWithAi(
  ctx: AppContext,
  product: NormalizedProduct,
  want: { copy: boolean; altText: boolean },
  warnings: CreateStoreResult["warnings"],
): Promise<NormalizedProduct> {
  if (!want.copy && !want.altText) return product;

  const credentials = resolveAiCredentials(ctx);
  if (!credentials) {
    const { provider } = getAiSettings(ctx);
    warnings.push({
      code: missingAiKeyCode(provider),
      message: `Skipped the AI steps — add your ${AI_PROVIDER_INFO[provider].label} key in Settings to use them.`,
    });
    return product;
  }

  let client;
  try {
    client = await createAiClient({
      provider: credentials.provider,
      apiKey: credentials.apiKey,
      model: credentials.model,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch (cause) {
    warnings.push(warningFor(cause, "The AI features couldn't be set up."));
    return product;
  }

  let enriched = product;

  if (want.copy) {
    try {
      const rewritten = await rewriteProductCopy(enriched, client);
      enriched = {
        ...enriched,
        description: rewritten.description,
        highlights:
          rewritten.highlights.length > 0
            ? rewritten.highlights
            : enriched.highlights,
      };
    } catch (cause) {
      warnings.push(
        warningFor(cause, "The AI copy rewrite failed; used the original description."),
      );
    }
  }

  if (want.altText) {
    try {
      enriched = withGeneratedAltText(
        enriched,
        await generateImageAltText(enriched, client),
      );
    } catch (cause) {
      warnings.push(
        warningFor(cause, "Couldn't generate image alt text; used the product title."),
      );
    }
  }

  return enriched;
}

function warningFor(
  cause: unknown,
  fallback: string,
): CreateStoreResult["warnings"][number] {
  return cause instanceof AppError
    ? { code: cause.code, message: cause.message }
    : { code: "INTERNAL", message: fallback };
}

/**
 * Downloads the product's images into the store.
 *
 * A generated store that hotlinks `ae01.alicdn.com` is not a storefront the
 * user owns: the URLs rot, the marketplace can block them, and every visitor
 * hits a site the user has no control over. Bundling the images makes the
 * project self-contained.
 *
 * Costs us nothing, by construction — the download runs on the user's machine
 * and the bytes land in their project, on their way to their own host.
 *
 * Failures are warnings: an image that won't download keeps its remote URL so
 * the store still builds and still shows a picture.
 */
async function bundleAssets(
  ctx: AppContext,
  product: NormalizedProduct,
  {
    outputDir,
    wanted,
    warnings,
  }: {
    outputDir: string;
    wanted: boolean;
    warnings: CreateStoreResult["warnings"];
  },
): Promise<NormalizedProduct> {
  if (!wanted) return product;

  try {
    const result = await localiseProductAssets(product, {
      outputDir,
      ...(ctx.assetFetchImpl ? { fetchImpl: ctx.assetFetchImpl } : {}),
    });

    if (result.failures.length > 0) {
      warnings.push({
        code: "FETCH_FAILED",
        message:
          result.failures.length === 1
            ? "One product image couldn't be downloaded and still points at AliExpress."
            : `${result.failures.length} product images couldn't be downloaded and still point at AliExpress.`,
      });
    }

    return result.product;
  } catch (cause) {
    warnings.push(
      warningFor(cause, "Couldn't bundle the product images; the store links to them instead."),
    );
    return product;
  }
}
