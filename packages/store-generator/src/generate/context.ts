import {
  computeRetailPriceCents,
  formatMoney,
  type NormalizedProduct,
  type StoreConfig,
} from "@repo/shared";

/**
 * Everything a template needs, computed once.
 *
 * Templates themselves are constant strings — all variable data is emitted into
 * `src/data/store.json` and read by the generated site at build time. That
 * keeps product text out of the markup we assemble by hand, so a quote or angle
 * bracket in a product title can't corrupt the generated store.
 */
export interface SiteContext {
  config: StoreConfig;
  product: NormalizedProduct;
  /** Slug-safe project name for the generated `package.json`. */
  packageName: string;
  /** The storefront's own retail price, derived from the sourced cost. */
  retailPriceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
}

export function buildContext(
  config: StoreConfig,
  product: NormalizedProduct,
): SiteContext {
  const currency = config.pricing.currency;
  const retailPriceCents = computeRetailPriceCents(
    product.price.amountCents,
    config.pricing,
  );

  // Only advertise a discount if the source itself did, marked up consistently
  // so the storefront never shows a "was" price below the "now" price.
  const compareAtPriceCents = product.compareAtPrice
    ? Math.max(
        computeRetailPriceCents(
          product.compareAtPrice.amountCents,
          config.pricing,
        ),
        retailPriceCents,
      )
    : null;

  return {
    config,
    product,
    packageName: slugify(config.storeName) || "storefront",
    retailPriceCents,
    compareAtPriceCents:
      compareAtPriceCents !== null && compareAtPriceCents > retailPriceCents
        ? compareAtPriceCents
        : null,
    currency,
  };
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * The data island written to `src/data/store.json`. Variant prices are marked
 * up with the same rules as the headline price so the picker stays consistent.
 */
export function buildStoreData(
  ctx: SiteContext,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    store: {
      name: ctx.config.storeName,
      tagline: ctx.config.tagline,
      supportEmail: ctx.config.supportEmail,
      currency: ctx.currency,
      shippingPolicy: ctx.config.shippingPolicy,
      returnsPolicy: ctx.config.returnsPolicy,
      theme: ctx.config.theme,
    },
    product: {
      id: ctx.product.sourceId,
      title: ctx.product.title,
      description: ctx.product.description,
      highlights: ctx.product.highlights,
      images: ctx.product.images,
      priceCents: ctx.retailPriceCents,
      compareAtPriceCents: ctx.compareAtPriceCents,
      priceDisplay: formatMoney(ctx.retailPriceCents, ctx.currency),
      compareAtDisplay:
        ctx.compareAtPriceCents === null
          ? null
          : formatMoney(ctx.compareAtPriceCents, ctx.currency),
      ratingAverage: ctx.product.ratingAverage,
      ratingCount: ctx.product.ratingCount,
      shipsFrom: ctx.product.shipsFrom,
      variants: ctx.product.variants.map((variant) => {
        const priceCents = computeRetailPriceCents(
          variant.priceCents,
          ctx.config.pricing,
        );
        return {
          id: variant.id,
          options: variant.options,
          available: variant.available,
          priceCents,
          priceDisplay: formatMoney(priceCents, ctx.currency),
        };
      }),
    },
    checkout: {
      provider: ctx.config.checkout.provider,
      paymentLinkUrl: ctx.config.checkout.paymentLinkUrl,
      variantPaymentLinks: ctx.config.checkout.variantPaymentLinks,
    },
    meta: {
      generatedAt: now.toISOString(),
      sourceUrl: ctx.product.sourceUrl,
    },
  };
}
