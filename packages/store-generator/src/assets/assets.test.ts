import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedProduct } from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extensionFromContentType,
  extensionFromUrl,
  fetchAsset,
  isDownloadable,
  localiseProductAssets,
  planAssets,
  sniffExtension,
  withLocalAssets,
  type BinaryFetchLike,
} from "./index.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const AVIF = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
]);

const product = (urls: string[]): NormalizedProduct => ({
  sourceId: "1",
  sourceUrl: "https://www.aliexpress.com/item/1.html",
  title: "Earbuds",
  description: "",
  highlights: [],
  price: { amountCents: 1000, currency: "USD" },
  compareAtPrice: null,
  images: urls.map((url) => ({ url, alt: "Earbuds" })),
  variants: [],
  ratingAverage: null,
  ratingCount: null,
  shipsFrom: null,
  scrapedAt: "2026-09-04T00:00:00.000Z",
});

/** Serves fixed bytes per URL, and 404s anything not listed. */
function serve(
  bodies: Record<string, Uint8Array>,
  contentType = "image/jpeg",
): BinaryFetchLike {
  return (async (url: string) => {
    const body = bodies[url];
    if (!body) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? contentType : null,
      },
      arrayBuffer: async () =>
        body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
    };
  }) as BinaryFetchLike;
}

describe("isDownloadable", () => {
  it("accepts http and https only", () => {
    expect(isDownloadable("https://cdn.example/a.jpg")).toBe(true);
    expect(isDownloadable("http://cdn.example/a.jpg")).toBe(true);
  });

  // A scraped page is untrusted input; these must never reach a fetch.
  it("refuses data, file and blob URLs from a scraped page", () => {
    expect(isDownloadable("data:image/png;base64,AAAA")).toBe(false);
    expect(isDownloadable("file:///etc/passwd")).toBe(false);
    expect(isDownloadable("blob:https://x/1")).toBe(false);
    expect(isDownloadable("not a url")).toBe(false);
  });
});

describe("sniffExtension", () => {
  it("identifies each format we serve", () => {
    expect(sniffExtension(JPEG)).toBe("jpg");
    expect(sniffExtension(PNG)).toBe("png");
    expect(sniffExtension(GIF)).toBe("gif");
    expect(sniffExtension(WEBP)).toBe("webp");
    expect(sniffExtension(AVIF)).toBe("avif");
  });

  it("returns null for something that isn't an image", () => {
    expect(sniffExtension(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]))).toBeNull();
  });
});

describe("extensionFromUrl", () => {
  it("reads a known extension", () => {
    expect(extensionFromUrl("https://cdn.example/a.PNG")).toBe("png");
  });

  it("normalises jpeg to jpg so one product can't produce both", () => {
    expect(extensionFromUrl("https://cdn.example/a.jpeg")).toBe("jpg");
  });

  it("returns null for an extensionless or unknown URL", () => {
    expect(extensionFromUrl("https://cdn.example/a")).toBeNull();
    expect(extensionFromUrl("https://cdn.example/a.exe")).toBeNull();
  });
});

describe("extensionFromContentType", () => {
  it("handles a charset parameter", () => {
    expect(extensionFromContentType("image/webp; charset=binary")).toBe("webp");
  });

  it("ignores types we can't serve", () => {
    expect(extensionFromContentType("text/html")).toBeNull();
    expect(extensionFromContentType(null)).toBeNull();
  });
});

describe("planAssets", () => {
  it("names images positionally, not from marketplace filenames", () => {
    const plan = planAssets([
      { url: "https://ae01.alicdn.com/kf/Hf3a9b2c.jpg", alt: "" },
      { url: "https://ae01.alicdn.com/kf/Hf3a9b2c.png", alt: "" },
    ]);

    expect(plan.map((entry) => entry.publicPath)).toEqual([
      "/images/product-01.jpg",
      "/images/product-02.png",
    ]);
    // The marketplace's own filename must not end up in the user's repo.
    for (const entry of plan) {
      expect(entry.filePath).not.toContain("Hf3a9b2c");
      expect(entry.publicPath).not.toContain("Hf3a9b2c");
    }
  });

  it("skips images it could never fetch", () => {
    expect(planAssets([{ url: "data:image/png;base64,AA", alt: "" }])).toEqual([]);
  });

  it("caps a padded gallery", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      url: `https://cdn.example/${i}.jpg`,
      alt: "",
    }));
    expect(planAssets(many).length).toBe(16);
  });
});

describe("fetchAsset", () => {
  it("trusts the bytes over the URL's claimed extension", async () => {
    // AliExpress genuinely serves AVIF behind .jpg addresses.
    const asset = await fetchAsset("https://cdn.example/a.jpg", {
      fetchImpl: serve({ "https://cdn.example/a.jpg": AVIF }, "image/jpeg"),
    });
    expect(asset.extension).toBe("avif");
  });

  it("falls back to content-type when the bytes are unrecognised", async () => {
    const asset = await fetchAsset("https://cdn.example/a", {
      fetchImpl: serve(
        { "https://cdn.example/a": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
        "image/png",
      ),
    });
    expect(asset.extension).toBe("png");
  });

  it("rejects a response that isn't an image at all", async () => {
    await expect(
      fetchAsset("https://cdn.example/a", {
        fetchImpl: serve(
          { "https://cdn.example/a": new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 1, 2, 3]) },
          "text/html",
        ),
      }),
    ).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("rejects an empty body rather than writing a zero-byte image", async () => {
    await expect(
      fetchAsset("https://cdn.example/a.jpg", {
        fetchImpl: serve({ "https://cdn.example/a.jpg": new Uint8Array() }),
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/came back empty/i) });
  });

  it("refuses an image over the size ceiling", async () => {
    await expect(
      fetchAsset("https://cdn.example/a.jpg", {
        fetchImpl: serve({ "https://cdn.example/a.jpg": JPEG }),
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/too large/i) });
  });

  it("reports a 404 as a fetch failure", async () => {
    await expect(
      fetchAsset("https://cdn.example/missing.jpg", { fetchImpl: serve({}) }),
    ).rejects.toMatchObject({ code: "FETCH_FAILED", detail: "HTTP 404" });
  });
});

describe("withLocalAssets", () => {
  it("keeps alt text, which the AI step may have written", () => {
    const source = product(["https://cdn.example/a.jpg"]);
    const withAlt = {
      ...source,
      images: [{ url: "https://cdn.example/a.jpg", alt: "AI-written alt" }],
    };

    const updated = withLocalAssets(
      withAlt,
      new Map([["https://cdn.example/a.jpg", "/images/product-01.jpg"]]),
    );
    expect(updated.images[0]).toEqual({
      url: "/images/product-01.jpg",
      alt: "AI-written alt",
    });
  });

  it("leaves an unmapped image alone", () => {
    const source = product(["https://cdn.example/a.jpg"]);
    expect(withLocalAssets(source, new Map()).images[0]?.url).toBe(
      "https://cdn.example/a.jpg",
    );
  });
});

describe("localiseProductAssets", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "dsv-assets-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("writes images into public/images and rewrites the product", async () => {
    const source = product([
      "https://ae01.alicdn.com/kf/a.jpg",
      "https://ae01.alicdn.com/kf/b.png",
    ]);

    const result = await localiseProductAssets(source, {
      outputDir,
      fetchImpl: serve({
        "https://ae01.alicdn.com/kf/a.jpg": JPEG,
        "https://ae01.alicdn.com/kf/b.png": PNG,
      }),
    });

    expect(result.failures).toEqual([]);
    expect(result.product.images.map((image) => image.url)).toEqual([
      "/images/product-01.jpg",
      "/images/product-02.png",
    ]);
    expect(readdirSync(join(outputDir, "public/images")).sort()).toEqual([
      "product-01.jpg",
      "product-02.png",
    ]);
    expect(
      readFileSync(join(outputDir, "public/images/product-01.jpg")).subarray(0, 3),
    ).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  // One dead image on a marketplace CDN must not cost the user their store.
  it("keeps the remote URL for an image it couldn't fetch, and warns", async () => {
    const source = product([
      "https://ae01.alicdn.com/kf/ok.jpg",
      "https://ae01.alicdn.com/kf/gone.jpg",
    ]);

    const result = await localiseProductAssets(source, {
      outputDir,
      fetchImpl: serve({ "https://ae01.alicdn.com/kf/ok.jpg": JPEG }),
    });

    expect(result.product.images[0]?.url).toBe("/images/product-01.jpg");
    expect(result.product.images[1]?.url).toBe("https://ae01.alicdn.com/kf/gone.jpg");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.url).toBe("https://ae01.alicdn.com/kf/gone.jpg");
  });

  it("keeps image order stable regardless of which finishes first", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://cdn.example/${i}.jpg`);
    const bodies = Object.fromEntries(urls.map((url) => [url, JPEG]));

    const result = await localiseProductAssets(product(urls), {
      outputDir,
      fetchImpl: serve(bodies),
    });

    expect(result.product.images.map((image) => image.url)).toEqual(
      urls.map(
        (_, i) => `/images/product-${String(i + 1).padStart(2, "0")}.jpg`,
      ),
    );
  });

  it("does nothing for a product with no usable images", async () => {
    const source = product(["data:image/png;base64,AAAA"]);
    const result = await localiseProductAssets(source, { outputDir, fetchImpl: serve({}) });

    expect(result.written).toEqual([]);
    expect(result.product).toBe(source);
  });
});
