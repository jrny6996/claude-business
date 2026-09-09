import { AppError, type NormalizedProduct, type ProductImage } from "@repo/shared";

/**
 * Bringing product images into the store as real files.
 *
 * A generated store used to point its `<img>` tags straight at
 * `ae01.alicdn.com`. That is not a storefront anyone owns: the URLs rot when a
 * listing changes, AliExpress can hotlink-block them at any time, and every
 * page view of the user's shop is a request to a marketplace they don't
 * control. Downloading the images makes the store self-contained — it builds,
 * deploys and renders with no dependency on the source listing.
 *
 * This costs us nothing, which is the point: the download happens on the
 * user's machine, the bytes land in the user's project, and they deploy to
 * their own host. No image ever passes through our infrastructure.
 */

/** Binary-capable fetch. The scrape layer's `FetchLike` is text-only. */
export type BinaryFetchLike = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Formats a storefront can serve directly. Anything else is left remote. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

const KNOWN_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);

/** Per-image ceiling. A product photo far above this is not a product photo. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Enough for a gallery; a listing with 60 images is padding, not product. */
export const MAX_ASSETS = 16;

export interface AssetPlanEntry {
  /** Where the bytes come from. */
  remoteUrl: string;
  /** Path inside the project, e.g. `public/images/product-01.jpg`. */
  filePath: string;
  /** What the storefront references, e.g. `/images/product-01.jpg`. */
  publicPath: string;
}

/**
 * Decides what every image will be called before anything is downloaded.
 *
 * Names are positional (`product-01`), not derived from the source URL:
 * AliExpress filenames are opaque hashes, sometimes collide across a gallery,
 * and would put marketplace identifiers into the user's own repository.
 */
export function planAssets(images: readonly ProductImage[]): AssetPlanEntry[] {
  return images.slice(0, MAX_ASSETS).flatMap((image, index) => {
    if (!isDownloadable(image.url)) return [];

    const extension = extensionFromUrl(image.url) ?? "jpg";
    const name = `product-${String(index + 1).padStart(2, "0")}.${extension}`;

    return [
      {
        remoteUrl: image.url,
        filePath: `public/images/${name}`,
        publicPath: `/images/${name}`,
      },
    ];
  });
}

/** Only ever http(s) — never a data:, file: or blob: URL from a scraped page. */
export function isDownloadable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function extensionFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const match = /\.([a-z0-9]{3,4})$/i.exec(pathname);
    const extension = match?.[1]?.toLowerCase();
    if (!extension || !KNOWN_EXTENSIONS.has(extension)) return null;
    return extension === "jpeg" ? "jpg" : extension;
  } catch {
    return null;
  }
}

/**
 * Identifies an image from its first bytes.
 *
 * The URL's extension is a claim, not a fact — AliExpress serves `.jpg` URLs
 * that are actually AVIF (see the `.jpg_.avif` suffix the scraper strips), and
 * writing those with the wrong extension gives the user a store full of images
 * their browser refuses to decode.
 */
export function sniffExtension(bytes: Uint8Array): string | null {
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  if (startsWith(0xff, 0xd8, 0xff)) return "jpg";
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif";

  // RIFF....WEBP
  if (startsWith(0x52, 0x49, 0x46, 0x46)) {
    const tag = String.fromCharCode(...bytes.slice(8, 12));
    if (tag === "WEBP") return "webp";
  }

  // ....ftypavif — the brand sits at offset 8 in the ISO-BMFF box.
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  if (brand.startsWith("ftyp") && brand.slice(4).startsWith("avif")) return "avif";

  return null;
}

export function extensionFromContentType(value: string | null): string | null {
  if (!value) return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[mime] ?? null;
}

export interface FetchedAsset {
  bytes: Uint8Array;
  /** The extension the bytes actually justify, best evidence first. */
  extension: string;
}

/**
 * Downloads one image and works out what it really is.
 *
 * Throws {@link AppError} `FETCH_FAILED` — callers treat a failed image as a
 * warning and keep the remote URL, because one unreachable photo must not cost
 * the user their store.
 */
export async function fetchAsset(
  url: string,
  {
    fetchImpl,
    timeoutMs = 30_000,
    maxBytes = MAX_ASSET_BYTES,
  }: { fetchImpl?: BinaryFetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedAsset> {
  const impl = (fetchImpl ?? globalThis.fetch) as unknown as BinaryFetchLike;
  if (typeof impl !== "function") {
    throw new AppError("FETCH_FAILED", "No network client is available.");
  }
  if (!isDownloadable(url)) {
    throw new AppError("FETCH_FAILED", "That image address isn't downloadable.", url);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await impl(url, {
      signal: controller.signal,
      headers: {
        // Some CDNs serve a placeholder to clients that don't look like a
        // browser, which would silently fill the store with grey squares.
        Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new AppError(
        "FETCH_FAILED",
        "That image couldn't be downloaded.",
        `HTTP ${response.status}`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength === 0) {
      throw new AppError("FETCH_FAILED", "That image came back empty.");
    }
    if (bytes.byteLength > maxBytes) {
      throw new AppError(
        "FETCH_FAILED",
        "That image is too large to bundle into the store.",
        `${Math.round(bytes.byteLength / 1024)}KB`,
      );
    }

    const extension =
      sniffExtension(bytes) ??
      extensionFromContentType(response.headers.get("content-type")) ??
      extensionFromUrl(url);

    if (!extension) {
      throw new AppError(
        "FETCH_FAILED",
        "That file didn't turn out to be an image.",
        url,
      );
    }

    return { bytes, extension };
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("FETCH_FAILED", "Couldn't download that image.", url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Points a product's images at their local copies.
 *
 * Alt text is preserved untouched — it may have been written by the AI step,
 * and re-deriving it here would quietly throw that away.
 */
export function withLocalAssets(
  product: NormalizedProduct,
  mapping: ReadonlyMap<string, string>,
): NormalizedProduct {
  if (mapping.size === 0) return product;

  return {
    ...product,
    images: product.images.map((image) => {
      const local = mapping.get(image.url);
      return local ? { ...image, url: local } : image;
    }),
  };
}
