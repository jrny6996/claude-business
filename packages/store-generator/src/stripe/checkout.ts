import {
  computeRetailPriceCents,
  type CheckoutConfig,
  type NormalizedProduct,
  type StoreConfig,
} from "@repo/shared";
import type { FetchLike } from "../scrape/fetch.js";
import { StripeClient } from "./client.js";

export interface ProvisionCheckoutOptions {
  secretKey: string;
  fetchImpl?: FetchLike;
  /** Create a separate link per variant as well as the base product. */
  includeVariants?: boolean;
  /** Cap on per-variant links, so a 200-variant listing doesn't hammer Stripe. */
  maxVariantLinks?: number;
}

/**
 * Creates the Stripe objects a generated storefront needs and returns the
 * checkout config to bake into it.
 *
 * Runs entirely on the user's machine against their own Stripe account. The
 * storefront only ever receives Stripe-hosted URLs — the secret key stays here.
 */
export async function provisionStripeCheckout(
  config: StoreConfig,
  product: NormalizedProduct,
  {
    secretKey,
    fetchImpl,
    includeVariants = true,
    maxVariantLinks = 20,
  }: ProvisionCheckoutOptions,
): Promise<CheckoutConfig> {
  const client = new StripeClient(
    fetchImpl ? { secretKey, fetchImpl } : { secretKey },
  );
  const currency = config.pricing.currency;

  const stripeProduct = await client.createProduct(
    product.title,
    describeForStripe(product, config),
  );

  const basePriceCents = computeRetailPriceCents(
    product.price.amountCents,
    config.pricing,
  );
  const price = await client.createPrice(
    stripeProduct.id,
    basePriceCents,
    currency,
  );
  const link = await client.createPaymentLink(price.id);

  const variantPaymentLinks: Record<string, string> = {};
  if (includeVariants) {
    // Only variants with a price genuinely different from the base one earn
    // their own Stripe objects; the rest reuse the base link.
    const distinct = product.variants
      .filter((variant) => variant.available)
      .filter(
        (variant) =>
          computeRetailPriceCents(variant.priceCents, config.pricing) !==
          basePriceCents,
      )
      .slice(0, maxVariantLinks);

    for (const variant of distinct) {
      const variantPrice = await client.createPrice(
        stripeProduct.id,
        computeRetailPriceCents(variant.priceCents, config.pricing),
        currency,
      );
      const variantLink = await client.createPaymentLink(variantPrice.id);
      variantPaymentLinks[variant.id] = variantLink.url;
    }
  }

  return {
    provider: "stripe",
    mode: "payment_link",
    waitlistEndpoint: config.checkout.waitlistEndpoint,
    paymentLinkUrl: link.url,
    variantPaymentLinks,
    stripePriceId: price.id,
    stripeProductId: stripeProduct.id,
  };
}

/** Validates a pasted Stripe secret key without storing anything. */
export async function validateStripeKey(
  secretKey: string,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const client = new StripeClient(
    fetchImpl ? { secretKey, fetchImpl } : { secretKey },
  );
  return client.validateKey();
}

function describeForStripe(
  product: NormalizedProduct,
  config: StoreConfig,
): string | undefined {
  const text = product.description.trim() || config.tagline.trim();
  return text || undefined;
}
