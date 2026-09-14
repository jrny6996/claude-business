import type { Money } from "./product.js";
import type { RetailPricing } from "./store.js";

/**
 * Computes the storefront's retail price from the sourced cost.
 *
 * This is the *store owner's* margin on their own product — it has nothing to
 * do with what we bill for the tool. Kept pure so it can be unit-tested and
 * reused identically by the generator and the preview UI.
 */
export function computeRetailPriceCents(
  costCents: number,
  pricing: RetailPricing,
): number {
  if (!Number.isFinite(costCents) || costCents < 0) return 0;

  const marked = costCents * pricing.markupMultiplier + pricing.handlingFeeCents;
  if (!pricing.charmPricing) return Math.round(marked);

  return applyCharmPricing(marked);
}

/**
 * Rounds up to the next `.99`. 1234c -> 1299c, 1299c -> 1299c, 1300c -> 1399c.
 * Anything below a dollar is floored at 99c so we never emit a $0.00 product.
 */
export function applyCharmPricing(amountCents: number): number {
  const rounded = Math.round(amountCents);
  if (rounded <= 99) return 99;

  const dollars = Math.floor(rounded / 100);
  return dollars * 100 + 99;
}

export function retailPrice(cost: Money, pricing: RetailPricing): Money {
  return {
    amountCents: computeRetailPriceCents(cost.amountCents, pricing),
    currency: pricing.currency,
  };
}

/** Formats cents for display, e.g. `2499` + `USD` -> `$24.99`. */
export function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}
