import { spawn } from "node:child_process";
import { once } from "node:events";
import { context } from "esbuild";
import electronPath from "electron";

const DEV_SERVER_URL = "http://localhost:5273";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  external: ["electron", "better-sqlite3"],
};

const mainCtx = await context({
  ...shared,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.js",
  format: "esm",
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

const preloadCtx = await context({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  format: "cjs",
});

await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

const vite = spawn("npx", ["vite", "--port", "5273", "--strictPort"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

// Wait for Vite to answer before pointing Electron at it, so the window never
// flashes an error page on a cold start.
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(DEV_SERVER_URL);
    if (response.ok) break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const electron = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, DSV_DEV_SERVER_URL: DEV_SERVER_URL },
});

const shutdown = async () => {
  electron.kill();
  vite.kill();
  await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await once(electron, "exit");
await shutdown();
