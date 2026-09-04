import { z } from "zod";
import { NormalizedProductSchema } from "./product.js";

export const ThemeSchema = z.object({
  /** Named preset shipped with the generator. */
  preset: z
    .enum(["minimal", "bold", "editorial", "warm", "noir"])
    .default("minimal"),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected a hex colour like #2563eb")
    .default("#2563eb"),
  fontStack: z.enum(["system", "serif", "mono"]).default("system"),
});
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Retail pricing for the *generated storefront* — i.e. what the user sells the
 * product for. This is the store owner's own margin, unrelated to our billing.
 */
export const RetailPricingSchema = z
  .object({
    /** Multiplier applied to the sourced cost, e.g. 2.5 for a 2.5x markup. */
    markupMultiplier: z.number().positive().max(50).default(2.5),
    /** Optional flat handling fee added after the markup, in cents. */
    handlingFeeCents: z.number().int().nonnegative().default(0),
    /** Round the final price to a `.99`-style ending. */
    charmPricing: z.boolean().default(true),
    currency: z.string().length(3).default("USD"),
  })
  .prefault({});
export type RetailPricing = z.infer<typeof RetailPricingSchema>;

/**
 * Checkout for the generated storefront.
 *
 * Stripe hosts the checkout page; we only ever hold the resulting URL. The
 * user's Stripe *secret* key stays in the desktop app's encrypted store and is
 * used once, on their machine, to create the payment link — it is never written
 * into a generated store and never reaches our infrastructure. No money and no
 * card data flows through us.
 */
export const CheckoutConfigSchema = z
  .object({
    /**
     * `stripe` is premium-only. Free stores get `waitlist`, which captures
     * interest instead of taking money — for validation that is arguably the
     * cleaner signal anyway.
     */
    provider: z.enum(["stripe", "waitlist", "none"]).default("waitlist"),
    /**
     * Where the waitlist form posts. The user's own form endpoint (Formspree,
     * Buttondown, their own webhook) — we never receive these addresses, and a
     * static store has nowhere to put them otherwise. With none set the form
     * falls back to a mailto: on the store's support address.
     */
    waitlistEndpoint: z.url().nullable().default(null),
    /** Stripe-hosted payment link for the base product. */
    paymentLinkUrl: z.url().nullable().default(null),
    /** Payment links per variant id, for multi-variant listings. */
    variantPaymentLinks: z.record(z.string(), z.url()).default({}),
    /** Stripe Price id, kept so the link can be rebuilt without re-creating it. */
    stripePriceId: z.string().nullable().default(null),
    stripeProductId: z.string().nullable().default(null),
  })
  .prefault({});
export type CheckoutConfig = z.infer<typeof CheckoutConfigSchema>;

export const StoreConfigSchema = z.object({
  storeName: z.string().min(1).max(60),
  tagline: z.string().max(160).default(""),
  supportEmail: z.email().nullable().default(null),
  theme: ThemeSchema.prefault({}),
  pricing: RetailPricingSchema,
  checkout: CheckoutConfigSchema,
  /** Free-text shipping/returns copy rendered into the storefront. */
  shippingPolicy: z.string().default(""),
  returnsPolicy: z.string().default(""),
});
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

export const StoreStatusSchema = z.enum([
  "draft",
  "generated",
  "deployed",
  "failed",
]);
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

export const StoreSchema = z.object({
  id: z.string().min(1),
  config: StoreConfigSchema,
  product: NormalizedProductSchema,
  status: StoreStatusSchema,
  /** Absolute path on the user's machine where the Astro project was written. */
  outputDir: z.string().nullable().default(null),
  /** Live URL once the user has deployed it to their own host. */
  deployedUrl: z.url().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Store = z.infer<typeof StoreSchema>;

/** A single file in a generated Astro project, relative to the project root. */
export interface GeneratedFile {
  path: string;
  contents: string;
}

export interface GeneratedSite {
  files: GeneratedFile[];
}
