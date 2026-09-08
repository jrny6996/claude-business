/**
 * Normalized product data.
 *
 * This is the contract between the scraping half of `@repo/store-generator`
 * and the site-emitting half. Nothing downstream of a scrape may depend on
 * AliExpress page structure — it may only depend on this shape.
 */
import { z } from "zod";

/**
 * Where an image lives.
 *
 * Two legal shapes, and the difference matters:
 *
 * - An absolute `http(s)` URL — straight off the source CDN, as scraped.
 * - A root-relative path like `/images/product-01.jpg` — the image has been
 *   downloaded into the generated store and is served by the user's own host.
 *
 * The second is the end state we want: a store that hotlinks a marketplace CDN
 * isn't one the user owns. Nothing is re-hosted by *us* in either case — the
 * download happens on the user's machine, into the user's project.
 */
export const ImageSrcSchema = z.union([
  z.url({ protocol: /^https?$/ }),
  z
    .string()
    .regex(
      /^\/[A-Za-z0-9._~\-/]*$/,
      "expected an absolute URL or a root-relative path",
    )
    // `..` in a path the storefront writes into an <img> src is never right.
    .refine((value) => !value.includes(".."), "path must not contain .."),
]);

export const ProductImageSchema = z.object({
  url: ImageSrcSchema,
  alt: z.string().default(""),
});
export type ProductImage = z.infer<typeof ProductImageSchema>;

export const ProductVariantSchema = z.object({
  id: z.string().min(1),
  /** e.g. `{ Color: "Black", Size: "XL" }` */
  options: z.record(z.string(), z.string()),
  priceCents: z.number().int().nonnegative(),
  available: z.boolean().default(true),
  sku: z.string().optional(),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const MoneySchema = z.object({
  amountCents: z.number().int(),
  currency: z.string().length(3).default("USD"),
});
export type Money = z.infer<typeof MoneySchema>;

export const NormalizedProductSchema = z.object({
  /** Stable id derived from the source URL, not from page markup. */
  sourceId: z.string().min(1),
  sourceUrl: z.url(),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Bulleted selling points, if the source exposed any. */
  highlights: z.array(z.string()).default([]),
  price: MoneySchema,
  /** Original/list price, when the source advertises a discount. */
  compareAtPrice: MoneySchema.nullable().default(null),
  images: z.array(ProductImageSchema).default([]),
  variants: z.array(ProductVariantSchema).default([]),
  ratingAverage: z.number().min(0).max(5).nullable().default(null),
  ratingCount: z.number().int().nonnegative().nullable().default(null),
  shipsFrom: z.string().nullable().default(null),
  scrapedAt: z.iso.datetime(),
});
export type NormalizedProduct = z.infer<typeof NormalizedProductSchema>;
