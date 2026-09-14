import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  AppError,
  StoreConfigSchema,
  type GeneratedFile,
  type GeneratedSite,
  type NormalizedProduct,
  type StoreConfig,
} from "@repo/shared";
import { buildContext, buildStoreData, slugify, type SiteContext } from "./context.js";
import { buyBoxAstro, cartLibTs, waitlistAstro } from "./templates/buybox.js";
import {
  footerAstro,
  galleryAstro,
  headerAstro,
  layoutAstro,
  ratingAstro,
} from "./templates/components.js";
import {
  cartAstro,
  indexAstro,
  notFoundAstro,
  policyAstro,
} from "./templates/pages.js";
import {
  astroConfig,
  faviconSvg,
  gitignore,
  packageJson,
  readme,
  robotsTxt,
  tsconfig,
} from "./templates/project.js";
import {
  checkoutApiTs,
  checkoutSuccessAstro,
} from "./templates/checkout-api.js";
import {
  developmentMd,
  editorconfig,
  envExample,
  nvmrc,
} from "./templates/dev-env.js";
import { globalCss, themeCss, waitlistCss } from "./templates/styles.js";

export * from "./context.js";
// The desktop app draws a miniature of each preset in its theme picker; reading
// the real tokens keeps those swatches from drifting from the generated store.
export {
  THEME_PRESETS,
  THEME_PRESET_TOKENS,
  isDarkPreset,
  readableInk,
  type Preset,
} from "./templates/styles.js";

export interface GenerateOptions {
  /** Injected in tests so generated output is byte-for-byte reproducible. */
  now?: Date;
}

/**
 * Turns normalized product data plus store settings into a complete Astro
 * project, in memory.
 *
 * This half knows nothing about AliExpress — it only consumes
 * {@link NormalizedProduct}. Swapping the product source never touches it.
 */
export function generateSite(
  config: StoreConfig,
  product: NormalizedProduct,
  { now = new Date() }: GenerateOptions = {},
): GeneratedSite {
  const parsedConfig = StoreConfigSchema.parse(config);
  const ctx = buildContext(parsedConfig, product);

  const files: GeneratedFile[] = [
    { path: "package.json", contents: packageJson(ctx) },
    { path: "astro.config.mjs", contents: astroConfig(ctx) },
    { path: "tsconfig.json", contents: tsconfig() },
    { path: ".gitignore", contents: gitignore() },
    { path: "README.md", contents: readme(ctx) },
    // The store is the user's own project, so it ships the things a project
    // needs: a pinned Node version, editor settings, and the env file the
    // checkout endpoint reads. See templates/dev-env.ts.
    { path: "DEVELOPMENT.md", contents: developmentMd(ctx) },
    { path: ".nvmrc", contents: nvmrc() },
    { path: ".editorconfig", contents: editorconfig() },
    { path: ".env.example", contents: envExample(ctx) },
    { path: "public/robots.txt", contents: robotsTxt() },
    { path: "public/favicon.svg", contents: faviconSvg() },
    {
      path: "src/data/store.json",
      contents: JSON.stringify(buildStoreData(ctx, now), null, 2) + "\n",
    },
    { path: "src/lib/cart.ts", contents: cartLibTs() },
    { path: "src/styles/theme.css", contents: themeCss(ctx) },
    { path: "src/styles/global.css", contents: globalCss() + waitlistCss() },
    { path: "src/layouts/Layout.astro", contents: layoutAstro() },
    { path: "src/components/Header.astro", contents: headerAstro() },
    { path: "src/components/Footer.astro", contents: footerAstro() },
    { path: "src/components/Gallery.astro", contents: galleryAstro() },
    { path: "src/components/Rating.astro", contents: ratingAstro() },
    { path: "src/components/BuyBox.astro", contents: buyBoxAstro() },
    { path: "src/components/Waitlist.astro", contents: waitlistAstro() },
    { path: "src/pages/index.astro", contents: indexAstro() },
    { path: "src/pages/cart.astro", contents: cartAstro() },
    { path: "src/pages/shipping.astro", contents: policyAstro("shipping") },
    { path: "src/pages/returns.astro", contents: policyAstro("returns") },
    { path: "src/pages/404.astro", contents: notFoundAstro() },
  ];

  // The checkout endpoint only exists where it can actually run.
  if (ctx.hasCheckoutApi) {
    files.push(
      { path: "src/pages/api/checkout.ts", contents: checkoutApiTs() },
      {
        path: "src/pages/checkout/success.astro",
        contents: checkoutSuccessAstro(),
      },
    );
  }

  return { files };
}

export interface WriteSiteOptions {
  /** Directory the project is written into. Created if it doesn't exist. */
  outputDir: string;
}

/**
 * Writes a generated site to disk.
 *
 * Every path is re-checked against the output directory before writing: the
 * file list is machine-generated today, but a traversal bug here would let a
 * scraped product write outside the folder the user picked.
 */
export async function writeSite(
  site: GeneratedSite,
  { outputDir }: WriteSiteOptions,
): Promise<string[]> {
  if (!isAbsolute(outputDir)) {
    throw new AppError(
      "WRITE_FAILED",
      "Choose a folder for the generated store.",
      "output directory must be an absolute path",
    );
  }

  const root = resolve(outputDir);
  const written: string[] = [];

  for (const file of site.files) {
    const target = resolve(root, normalize(file.path));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new AppError(
        "WRITE_FAILED",
        "The generated store contained an unsafe file path and was not written.",
        file.path,
      );
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    } catch {
      throw new AppError(
        "WRITE_FAILED",
        "Couldn't write the store to that folder. Check you have permission to write there.",
        file.path,
      );
    }

    written.push(target);
  }

  return written;
}

/** Convenience: generate and write in one step. */
export async function generateAndWriteSite(
  config: StoreConfig,
  product: NormalizedProduct,
  outputDir: string,
  options: GenerateOptions = {},
): Promise<{ site: GeneratedSite; written: string[]; outputDir: string }> {
  const site = generateSite(config, product, options);
  const written = await writeSite(site, { outputDir });
  return { site, written, outputDir };
}

/** Default folder name for a store, e.g. `my-shop-1005006`. */
export function defaultOutputDirName(
  config: StoreConfig,
  product: NormalizedProduct,
): string {
  return `${slugify(config.storeName) || "storefront"}-${product.sourceId}`;
}

export function joinOutputDir(baseDir: string, name: string): string {
  return join(baseDir, name);
}

export type { SiteContext };
