import { contextBridge, ipcRenderer } from "electron";

/**
 * The entire surface the renderer gets.
 *
 * Note what is absent: no filesystem, no database handle, no secret access, no
 * general-purpose IPC. Requests are addressed by method and path and answered
 * by the Hono app in the main process, so the renderer can never read a stored
 * API key even if a scraped product title managed to inject script into it.
 */
const bridge = {
  request(method: string, path: string, body?: unknown) {
    return ipcRenderer.invoke("api:request", { method, path, body }) as Promise<{
      status: number;
      body: unknown;
    }>;
  },
  chooseDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("dialog:chooseDirectory") as Promise<string | null>;
  },
  openPath(target: string): Promise<boolean> {
    return ipcRenderer.invoke("shell:openPath", target) as Promise<boolean>;
  },
  openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke("shell:openExternal", url) as Promise<boolean>;
  },
  info(): Promise<{ version: string; platform: string; isDev: boolean }> {
    return ipcRenderer.invoke("app:info") as Promise<{
      version: string;
      platform: string;
      isDev: boolean;
    }>;
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);

export type DesktopBridge = typeof bridge;
