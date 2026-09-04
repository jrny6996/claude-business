import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  StoreConfigSchema,
  type NormalizedProduct,
  type StoreConfig,
} from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContext, slugify } from "./context.js";
import {
  defaultOutputDirName,
  generateSite,
  writeSite,
} from "./index.js";
import { readableInk } from "./templates/styles.js";

const now = new Date("2026-09-04T12:00:00.000Z");

const product: NormalizedProduct = {
  sourceId: "1005006123456789",
  sourceUrl: "https://www.aliexpress.com/item/1005006123456789.html",
  title: 'Wireless Earbuds "Pro" <ANC> & More',
  description: "Great earbuds.",
  highlights: ["40h battery", "IPX5"],
  price: { amountCents: 1899, currency: "USD" },
  compareAtPrice: { amountCents: 3999, currency: "USD" },
  images: [
    { url: "https://ae01.alicdn.com/kf/one.jpg", alt: "one" },
    { url: "https://ae01.alicdn.com/kf/two.jpg", alt: "two" },
  ],
  variants: [
    { id: "12001", options: { Color: "Black" }, priceCents: 1899, available: true },
    { id: "12002", options: { Color: "White" }, priceCents: 2150, available: true },
  ],
  ratingAverage: 4.7,
  ratingCount: 2841,
  shipsFrom: "China",
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

const config: StoreConfig = StoreConfigSchema.parse({
  storeName: "Sound Lab",
  tagline: "Audio worth hearing",
  supportEmail: "hi@soundlab.test",
  pricing: { markupMultiplier: 2, charmPricing: true, currency: "USD" },
  checkout: {
    provider: "stripe",
    paymentLinkUrl: "https://buy.stripe.com/test_base",
    variantPaymentLinks: { "12002": "https://buy.stripe.com/test_white" },
  },
});

const fileMap = (): Map<string, string> =>
  new Map(
    generateSite(config, product, { now }).files.map((f) => [f.path, f.contents]),
  );

describe("slugify", () => {
  it("makes a safe package name", () => {
    expect(slugify("Sound Lab!! ")).toBe("sound-lab");
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
  });

  it("returns empty for a name with nothing usable", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("readableInk", () => {
  it("picks dark text on a light accent", () => {
    expect(readableInk("#fde047")).toBe("#111827");
  });

  it("picks light text on a dark accent", () => {
    expect(readableInk("#2563eb")).toBe("#ffffff");
  });
});

describe("buildContext", () => {
  it("marks up the sourced price into a retail price", () => {
    const ctx = buildContext(config, product);
    // 1899 * 2 = 3798 -> charm -> 3799
    expect(ctx.retailPriceCents).toBe(3799);
  });

  it("marks up the compare-at price consistently", () => {
    const ctx = buildContext(config, product);
    // 3999 * 2 = 7998 -> charm -> 7999
    expect(ctx.compareAtPriceCents).toBe(7999);
  });

  it("drops a compare-at price that isn't above the retail price", () => {
    const ctx = buildContext(config, { ...product, compareAtPrice: null });
    expect(ctx.compareAtPriceCents).toBeNull();
  });
});

describe("generateSite", () => {
  it("emits a complete Astro project", () => {
    const files = fileMap();
    for (const expected of [
      "package.json",
      "astro.config.mjs",
      "tsconfig.json",
      "README.md",
      "src/data/store.json",
      "src/lib/cart.ts",
      "src/styles/theme.css",
      "src/styles/global.css",
      "src/layouts/Layout.astro",
      "src/components/BuyBox.astro",
      "src/pages/index.astro",
      "src/pages/cart.astro",
      "src/pages/404.astro",
      "public/favicon.svg",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("writes product data into store.json, not into the markup", () => {
    const files = fileMap();
    const data = JSON.parse(files.get("src/data/store.json")!);

    expect(data.product.title).toBe(product.title);
    expect(data.product.priceCents).toBe(3799);
    expect(data.product.priceDisplay).toBe("$37.99");
    expect(data.product.compareAtDisplay).toBe("$79.99");

    // The product title contains quotes and angle brackets; no template should
    // have interpolated it into markup.
    expect(files.get("src/pages/index.astro")).not.toContain("Wireless Earbuds");
    expect(files.get("src/components/BuyBox.astro")).not.toContain("Wireless Earbuds");
  });

  it("marks up variant prices with the same rules as the headline price", () => {
    const data = JSON.parse(fileMap().get("src/data/store.json")!);
    expect(data.product.variants).toEqual([
      {
        id: "12001",
        options: { Color: "Black" },
        available: true,
        priceCents: 3799,
        priceDisplay: "$37.99",
      },
      {
        id: "12002",
        options: { Color: "White" },
        available: true,
        priceCents: 4399,
        priceDisplay: "$43.99",
      },
    ]);
  });

  it("carries the Stripe payment links into the store data", () => {
    const data = JSON.parse(fileMap().get("src/data/store.json")!);
    expect(data.checkout).toEqual({
      provider: "stripe",
      paymentLinkUrl: "https://buy.stripe.com/test_base",
      variantPaymentLinks: { "12002": "https://buy.stripe.com/test_white" },
      waitlistEndpoint: null,
    });
  });

  it("never writes a Stripe secret key into the generated store", () => {
    for (const file of generateSite(config, product, { now }).files) {
      expect(file.contents).not.toMatch(/sk_live|sk_test|rk_live/);
    }
  });

  it("builds a waitlist store when that is the provider", () => {
    const waitlist = StoreConfigSchema.parse({
      storeName: "Sound Lab",
      supportEmail: "hi@soundlab.test",
      checkout: {
        provider: "waitlist",
        waitlistEndpoint: "https://formspree.io/f/demo",
      },
    });
    const files = new Map(
      generateSite(waitlist, product, { now }).files.map((f) => [f.path, f.contents]),
    );

    expect(files.has("src/components/Waitlist.astro")).toBe(true);
    expect(JSON.parse(files.get("src/data/store.json")!).checkout).toMatchObject({
      provider: "waitlist",
      waitlistEndpoint: "https://formspree.io/f/demo",
    });
    // A store that can't take an order must not advertise a cart.
    expect(files.get("src/components/Header.astro")).toContain("showCart");
    expect(files.get("src/components/BuyBox.astro")).toContain("isWaitlist");
  });

  it("degrades to a disabled checkout when no payment link exists", () => {
    const noCheckout = StoreConfigSchema.parse({
      storeName: "Sound Lab",
      checkout: { provider: "none" },
    });
    const files = new Map(
      generateSite(noCheckout, product, { now }).files.map((f) => [f.path, f.contents]),
    );
    const data = JSON.parse(files.get("src/data/store.json")!);

    expect(data.checkout.paymentLinkUrl).toBeNull();
    expect(files.get("src/components/BuyBox.astro")).toContain(
      "Checkout isn't connected yet",
    );
  });

  it("names the generated package after the store", () => {
    const pkg = JSON.parse(fileMap().get("package.json")!);
    expect(pkg.name).toBe("sound-lab");
    expect(pkg.dependencies.astro).toBeDefined();
  });

  it("applies theme tokens to the stylesheet", () => {
    const themed = StoreConfigSchema.parse({
      storeName: "T",
      theme: { accentColor: "#ff0000", preset: "bold", fontStack: "serif" },
    });
    const css = generateSite(themed, product, { now }).files.find(
      (f) => f.path === "src/styles/theme.css",
    )!.contents;

    expect(css).toContain("--accent: #ff0000;");
    expect(css).toContain("Georgia");
  });

  it("is deterministic for a fixed clock", () => {
    const a = generateSite(config, product, { now });
    const b = generateSite(config, product, { now });
    expect(a).toEqual(b);
  });

  it("rejects a config the schema doesn't accept", () => {
    expect(() =>
      generateSite({ ...config, storeName: "" }, product, { now }),
    ).toThrow();
  });
});

describe("writeSite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsv-site-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes every file to disk", async () => {
    const site = generateSite(config, product, { now });
    const written = await writeSite(site, { outputDir: dir });

    expect(written).toHaveLength(site.files.length);
    expect(
      JSON.parse(readFileSync(join(dir, "src/data/store.json"), "utf8")).store.name,
    ).toBe("Sound Lab");
  });

  it("refuses a relative output directory", async () => {
    await expect(
      writeSite(generateSite(config, product, { now }), { outputDir: "./out" }),
    ).rejects.toThrow(AppError);
  });

  it("refuses to write outside the output directory", async () => {
    const evil = { files: [{ path: "../escaped.txt", contents: "nope" }] };
    await expect(writeSite(evil, { outputDir: dir })).rejects.toThrowError(
      /unsafe file path/,
    );
  });
});

describe("defaultOutputDirName", () => {
  it("combines the store slug and the source id", () => {
    expect(defaultOutputDirName(config, product)).toBe(
      "sound-lab-1005006123456789",
    );
  });
});
