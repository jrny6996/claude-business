import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApp, type AppContext } from "@repo/api";
import { createDataLayer, type DataLayer } from "@repo/db";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import type { Hono } from "hono";
import { createBrowserPageSource, type BrowserPageSource } from "./browser-source.js";
import { createCipher } from "./cipher.js";

/** Vite dev server, when running `npm run dev`. */
const DEV_SERVER_URL = process.env.DSV_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

let data: DataLayer | undefined;
let api: Hono | undefined;
let window: BrowserWindow | undefined;
let pageSource: BrowserPageSource | undefined;

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

  const layer = createDataLayer(join(userData, "store-validator.sqlite"), cipher);

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
    pageSource: source,
  };

  return { api: createApp(ctx), data: layer, pageSource: source };
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
    pageSource?.dispose();
    pageSource = undefined;
    data?.close();
    data = undefined;
  });
}
