import { defineConfig } from "astro/config";

/**
 * The marketing site: fully static, as it was.
 *
 * The hosted licensing and backup service does **not** run through Astro. It is
 * a single Netlify Function (`netlify/functions/api.mts`) mounted at `/api/*`,
 * which keeps every page here prerendered to plain files that cost nothing to
 * serve, and keeps the one thing that does cost us money in one file.
 *
 * This is also why there is no Astro adapter: `@astrojs/netlify` pulls in
 * Netlify's function bundler at config-load time, and that chain reads
 * TypeScript's classic `ts.TypeFlags` through ts-api-utils — which the native
 * TypeScript 7 compiler this repo builds with does not expose. Netlify bundles
 * the function itself at deploy time, so nothing is lost by leaving it out.
 */
export default defineConfig({
  output: "static",
  build: { format: "directory" },
});
