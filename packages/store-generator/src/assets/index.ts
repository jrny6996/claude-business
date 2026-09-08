import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { AppError, type NormalizedProduct } from "@repo/shared";
import {
  MAX_ASSETS,
  fetchAsset,
  isDownloadable,
  withLocalAssets,
  type BinaryFetchLike,
} from "./download.js";

export * from "./download.js";

export interface LocaliseAssetsOptions {
  /** The generated Astro project. Images land under `public/images/`. */
  outputDir: string;
  fetchImpl?: BinaryFetchLike;
  /** Images fetched at once. Enough to be quick, few enough to be polite. */
  concurrency?: number;
  timeoutMs?: number;
}

export interface AssetFailure {
  url: string;
  message: string;
}

export interface LocaliseAssetsResult {
  /** The product with its images pointing at local files. */
  product: NormalizedProduct;
  written: string[];
  /** Images that stayed remote, and why. Surfaced to the user as warnings. */
  failures: AssetFailure[];
}

/**
 * Downloads a product's images into the generated store.
 *
 * Partial success is the normal case and is handled as such: an image that
 * can't be fetched keeps its original remote URL, the store still builds, and
 * the caller gets a warning naming what stayed remote. Losing a whole store
 * over one 404 on a marketplace CDN would be absurd.
 *
 * Runs entirely on the user's machine — see the note in `download.ts`.
 */
export async function localiseProductAssets(
  product: NormalizedProduct,
  { outputDir, fetchImpl, concurrency = 4, timeoutMs }: LocaliseAssetsOptions,
): Promise<LocaliseAssetsResult> {
  const root = resolve(outputDir);
  const candidates = product.images
    .slice(0, MAX_ASSETS)
    .map((image, index) => ({ url: image.url, index }))
    .filter((entry) => isDownloadable(entry.url));

  if (candidates.length === 0) {
    return { product, written: [], failures: [] };
  }

  const mapping = new Map<string, string>();
  const written: string[] = [];
  const failures: AssetFailure[] = [];

  // A simple worker pool: images are independent, and a listing can carry a
  // dozen of them.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = cursor++;
      const entry = candidates[next];
      if (!entry) return;

      try {
        const asset = await fetchAsset(entry.url, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });

        // Named from the sniffed type, not the URL's claim: AliExpress serves
        // AVIF bytes behind .jpg addresses, and the wrong extension gives the
        // user a gallery their browser won't decode.
        const name = `product-${String(entry.index + 1).padStart(2, "0")}.${asset.extension}`;
        const target = resolve(root, "public", "images", name);

        if (target !== root && !target.startsWith(root + sep)) {
          throw new AppError(
            "WRITE_FAILED",
            "An image resolved outside the store folder and was not written.",
            name,
          );
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, asset.bytes);

        mapping.set(entry.url, `/images/${name}`);
        written.push(target);
      } catch (cause) {
        failures.push({
          url: entry.url,
          message:
            cause instanceof AppError
              ? cause.message
              : "That image couldn't be downloaded.",
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  return {
    product: withLocalAssets(product, mapping),
    written: written.sort(),
    failures,
  };
}
