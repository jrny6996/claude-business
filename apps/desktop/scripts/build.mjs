import { build } from "esbuild";

/**
 * Bundles the Electron main and preload scripts.
 *
 * The main process is ESM (Electron 44 supports it) while the preload must be
 * CJS, because a sandboxed preload is loaded as CommonJS. Native and Electron
 * modules stay external and resolve from node_modules at runtime.
 */
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  external: ["electron", "better-sqlite3"],
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["electron/main.ts"],
    outfile: "dist-electron/main.js",
    format: "esm",
    banner: {
      // esbuild's ESM output can reference these; Electron's main is ESM so
      // they aren't defined by default.
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  }),
  build({
    ...shared,
    entryPoints: ["electron/preload.ts"],
    outfile: "dist-electron/preload.cjs",
    format: "cjs",
  }),
]);
