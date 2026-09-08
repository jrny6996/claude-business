import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PENDING_RESTORE_FILE, createApp, type AppContext } from "@repo/api";
import { AppError, toAppError } from "@repo/shared";
import { createDataLayer, type DataLayer } from "@repo/db";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import type { Hono } from "hono";
import { createBrowserPageSource, type BrowserPageSource } from "./browser-source.js";
import { createCipher } from "./cipher.js";
import { DevEnvManager } from "./dev-env.js";
import { PreviewServer } from "./preview-server.js";

/** Vite dev server, when running `npm run dev`. */
const DEV_SERVER_URL = process.env.DSV_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

let data: DataLayer | undefined;
let api: Hono | undefined;
let window: BrowserWindow | undefined;
let pageSource: BrowserPageSource | undefined;
let previews: PreviewServer | undefined;
let devEnv: DevEnvManager | undefined;

function bootstrap(): {
  api: Hono;
  data: DataLayer;
  pageSource: BrowserPageSource;
} {
  const userData = app.getPath("userData");
  const { cipher, osBacked } = createCipher();

  if (!osBacked) {
    console.warn(
      "[store-validator] OS keychain unavailable; secrets fall back to a local key file.",
    );
  }

  const databasePath = join(userData, "store-validator.sqlite");
  adoptPendingRestore(userData, databasePath);

  const layer = createDataLayer(databasePath, cipher);

  // Product pages are loaded in a real Chromium window: AliExpress renders its
  // data client-side and blocks plain HTTP clients. If it challenges us, the
  // window is shown so the user can clear the check themselves.
  const source = createBrowserPageSource({
    events: {
      onChallenge: (info) => {
        window?.webContents.send("scrape:challenge", info);
      },
      onResolved: () => {
        window?.webContents.send("scrape:challenge-resolved");
      },
    },
  });

  const ctx: AppContext = {
    data: layer,
    storesDir: join(app.getPath("documents"), "Store Validator"),
    databaseDir: userData,
    pageSource: source,
    ...(process.env.DSV_CLOUD_URL ? { cloudBaseUrl: process.env.DSV_CLOUD_URL } : {}),
  };

  return { api: createApp(ctx), data: layer, pageSource: source };
}

/**
 * Adopts a database staged by a cloud restore.
 *
 * Restores are applied here, at boot, before anything opens a connection —
 * swapping the file under a running app, with WAL files beside it and
 * statements prepared against it, is how you corrupt someone's data while
 * trying to rescue it.
 *
 * The previous database is renamed rather than deleted. A restore is something
 * people do when they are already in trouble, and it must not be the thing that
 * destroys the copy they had.
 */
function adoptPendingRestore(userData: string, databasePath: string): void {
  const pending = join(userData, PENDING_RESTORE_FILE);
  if (!existsSync(pending)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  try {
    if (existsSync(databasePath)) {
      renameSync(databasePath, `${databasePath}.before-restore-${stamp}`);
    }
    // The WAL and shm belong to the database being replaced; leaving them would
    // have SQLite apply another database's journal to this one.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${databasePath}${suffix}`)) {
        renameSync(
          `${databasePath}${suffix}`,
          `${databasePath}${suffix}.before-restore-${stamp}`,
        );
      }
    }

    renameSync(pending, databasePath);
    console.info("[store-validator] Restored a backup from the cloud.");
  } catch (cause) {
    console.error("[store-validator] Couldn't apply the staged restore.", cause);
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f3f2f2",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      // The renderer is untrusted by construction: it renders scraped product
      // text. It gets no Node access and no direct database handle — only the
      // narrow bridge in preload.cjs.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Closing the main UI tears the hidden scrape window down with it, so a
  // background window can never keep the process alive on its own.
  win.on("closed", () => {
    if (window === win) window = undefined;
    // Dispose but keep the reference: the API context still holds this source
    // and will transparently recreate its window if a scrape happens later.
    pageSource?.dispose();
  });

  // Any attempt to navigate away or open a window goes to the real browser
  // instead — a generated store's links must never take over the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return;
    event.preventDefault();
    void openExternal(url);
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    const indexHtml = join(import.meta.dirname, "../dist/renderer/index.html");
    if (existsSync(indexHtml)) {
      void win.loadFile(indexHtml);
    } else {
      void win.loadURL(
        "data:text/html," +
          encodeURIComponent(
            "<h1>Renderer not built</h1><p>Run <code>npm run build</code> in apps/desktop.</p>",
          ),
      );
    }
  }

  return win;
}

/** Only ever opens http(s) — never a file path or a custom scheme. */
async function openExternal(rawUrl: string): Promise<boolean> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

/** Wraps a handler so failures cross IPC as a readable error, not a stack. */
async function envelope<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ReturnType<typeof toAppError> }> {
  try {
    return { ok: true, value: await run() };
  } catch (cause) {
    return { ok: false, error: toAppError(cause) };
  }
}

/**
 * Bridges renderer requests into the Hono app.
 *
 * The API is invoked in-process via `app.fetch` rather than over a TCP port, so
 * nothing else on the machine can drive it and there is no port or token to
 * manage.
 */
function registerIpc(): void {
  ipcMain.handle(
    "api:request",
    async (
      _event,
      payload: { method: string; path: string; body?: unknown },
    ): Promise<{ status: number; body: unknown }> => {
      if (!api) throw new Error("API is not ready");

      const method = String(payload?.method ?? "GET").toUpperCase();
      const path = String(payload?.path ?? "/");
      if (!path.startsWith("/api/")) {
        return {
          status: 400,
          body: { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint." } },
        };
      }

      const init: RequestInit = { method };
      if (payload.body !== undefined && method !== "GET") {
        init.body = JSON.stringify(payload.body);
        init.headers = { "Content-Type": "application/json" };
      }

      const response = await api.fetch(
        new Request(`http://local.invalid${path}`, init),
      );

      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
  );

  ipcMain.handle("dialog:chooseDirectory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("shell:openPath", async (_event, target: string) => {
    // Only paths we generated are openable, so a store's own data can never
    // talk the app into revealing an arbitrary file.
    const store = typeof target === "string" ? target : "";
    if (!store || !existsSync(store)) return false;
    await shell.openPath(store);
    return true;
  });

  ipcMain.handle("shell:openExternal", (_event, url: string) =>
    openExternal(typeof url === "string" ? url : ""),
  );

  // Preview: an Astro dev server per store, serving the real generated site.
  ipcMain.handle(
    "preview:start",
    async (_event, payload: { storeId: string; projectDir: string }) => {
      if (!previews) throw new Error("Preview server is not ready");
      const handle = await previews.start(payload.storeId, payload.projectDir);
      return { url: handle.url };
    },
  );

  ipcMain.handle("preview:stop", async (_event, storeId: string) => {
    await previews?.stop(String(storeId));
    return true;
  });

  ipcMain.handle("preview:status", (_event, storeId: string) => {
    const handle = previews?.get(String(storeId));
    return handle ? { url: handle.url } : null;
  });

  // Dev environment: turn a generated store into a project the user can open
  // in their own editor and run with their own npm.
  //
  // These answer with the same `{ ok, value | error }` envelope the API uses.
  // A thrown error crossing `ipcMain.handle` reaches the renderer wrapped in
  // Electron's own "Error invoking remote method" text, which would bury the
  // message the user actually needs to read.
  ipcMain.handle(
    "devenv:status",
    (_event, payload: { storeId: string; projectDir: string }) =>
      envelope(async () => {
        if (!devEnv) throw new AppError("INTERNAL", "The app isn't ready yet.");
        return devEnv.status(String(payload.storeId), String(payload.projectDir));
      }),
  );

  ipcMain.handle(
    "devenv:install",
    (_event, payload: { storeId: string; projectDir: string }) =>
      envelope(async () => {
        if (!devEnv) throw new AppError("INTERNAL", "The app isn't ready yet.");

        const storeId = String(payload.storeId);
        // The preview's dev server is running out of the shared runtime we are
        // about to unlink; leaving it up would break it mid-install.
        await previews?.stop(storeId);

        return devEnv.install(storeId, String(payload.projectDir), (event) => {
          window?.webContents.send("devenv:progress", event);
        });
      }),
  );

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    isDev: IS_DEV,
  }));
}

// A second instance would open the same SQLite file twice; hand focus to the
// window that already exists instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    const started = bootstrap();
    api = started.api;
    data = started.data;
    pageSource = started.pageSource;

    previews = new PreviewServer();
    devEnv = new DevEnvManager();
    registerIpc();
    window = createWindow();

    app.on("activate", () => {
      // Tracked explicitly rather than counting windows: the scrape window
      // lingers hidden between scrapes and would otherwise look like a live UI.
      if (!window || window.isDestroyed()) window = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });


  app.on("before-quit", () => {
    // Dev servers are daemons; without this they outlive the app.
    void previews?.stopAll();
    pageSource?.dispose();
    pageSource = undefined;
    data?.close();
    data = undefined;
  });
}
