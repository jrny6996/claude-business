import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

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
  startPreview(storeId: string, projectDir: string): Promise<{ url: string }> {
    return ipcRenderer.invoke("preview:start", { storeId, projectDir }) as Promise<{
      url: string;
    }>;
  },
  stopPreview(storeId: string): Promise<boolean> {
    return ipcRenderer.invoke("preview:stop", storeId) as Promise<boolean>;
  },
  previewStatus(storeId: string): Promise<{ url: string } | null> {
    return ipcRenderer.invoke("preview:status", storeId) as Promise<{
      url: string;
    } | null>;
  },
  /**
   * Notifies the UI that AliExpress is asking a human to clear a check. Only
   * the main process can emit these; the renderer can only listen.
   */
  onScrapeChallenge(
    listener: (info: { url: string; kind: string } | null) => void,
  ): () => void {
    const onChallenge = (_event: IpcRendererEvent, info: unknown) =>
      listener(info as { url: string; kind: string });
    const onResolved = () => listener(null);

    ipcRenderer.on("scrape:challenge", onChallenge);
    ipcRenderer.on("scrape:challenge-resolved", onResolved);

    return () => {
      ipcRenderer.removeListener("scrape:challenge", onChallenge);
      ipcRenderer.removeListener("scrape:challenge-resolved", onResolved);
    };
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);

export type DesktopBridge = typeof bridge;
