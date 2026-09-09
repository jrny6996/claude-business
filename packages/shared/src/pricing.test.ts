import { describe, expect, it } from "vitest";
import {
  applyCharmPricing,
  computeRetailPriceCents,
  formatMoney,
  retailPrice,
} from "./pricing.js";
import { RetailPricingSchema } from "./store.js";

const pricing = (over: Partial<Record<string, unknown>> = {}) =>
  RetailPricingSchema.parse(over);

describe("applyCharmPricing", () => {
  it("rounds up to the next .99", () => {
    expect(applyCharmPricing(1234)).toBe(1299);
    expect(applyCharmPricing(1299)).toBe(1299);
    expect(applyCharmPricing(1300)).toBe(1399);
  });

  it("never emits a free product", () => {
    expect(applyCharmPricing(0)).toBe(99);
    expect(applyCharmPricing(50)).toBe(99);
  });
});

describe("computeRetailPriceCents", () => {
  it("applies the markup multiplier", () => {
    const p = pricing({ markupMultiplier: 2, charmPricing: false });
    expect(computeRetailPriceCents(1000, p)).toBe(2000);
  });

  it("adds the handling fee after the markup", () => {
    const p = pricing({
      markupMultiplier: 2,
      handlingFeeCents: 500,
      charmPricing: false,
    });
    expect(computeRetailPriceCents(1000, p)).toBe(2500);
  });

  it("applies charm pricing last", () => {
    const p = pricing({ markupMultiplier: 2.5, charmPricing: true });
    // 1000 * 2.5 = 2500 -> 2499? no: 2500 -> floor(25) * 100 + 99 = 2599
    expect(computeRetailPriceCents(1000, p)).toBe(2599);
  });

  it("rejects nonsense costs rather than producing NaN prices", () => {
    const p = pricing();
    expect(computeRetailPriceCents(Number.NaN, p)).toBe(0);
    expect(computeRetailPriceCents(-100, p)).toBe(0);
  });
});

describe("retailPrice", () => {
  it("carries the storefront currency, not the source currency", () => {
    const p = pricing({ currency: "EUR", markupMultiplier: 2 });
    expect(retailPrice({ amountCents: 1000, currency: "USD" }, p)).toEqual({
      amountCents: 2099,
      currency: "EUR",
    });
  });
});

describe("formatMoney", () => {
  it("formats cents as currency", () => {
    expect(formatMoney(2499, "USD")).toBe("$24.99");
  });
});
