import type { AppErrorShape } from "@repo/shared";

/** Mirrors the surface `electron/preload.ts` exposes. */
export interface DesktopBridge {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  chooseDirectory(): Promise<string | null>;
  openPath(target: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  info(): Promise<{ version: string; platform: string; isDev: boolean }>;
  onScrapeChallenge(
    listener: (info: { url: string; kind: string } | null) => void,
  ): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor({ code, message, detail }: AppErrorShape) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const bridge = (): DesktopBridge => {
  if (!window.desktop) {
    throw new ApiError({
      code: "INTERNAL",
      message: "The app isn't fully loaded yet. Try restarting it.",
    });
  }
  return window.desktop;
};

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: AppErrorShape;
}

/**
 * Calls the embedded API and unwraps the result envelope.
 *
 * Every failure surfaces as an {@link ApiError} carrying the API's own
 * user-facing message, so screens never have to invent error copy.
 */
export async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { body: payload } = await bridge().request(method, path, body);
  const envelope = payload as Envelope<T> | null;

  if (!envelope || typeof envelope !== "object") {
    throw new ApiError({ code: "INTERNAL", message: "The app got an empty response." });
  }
  if (!envelope.ok) {
    throw new ApiError(
      envelope.error ?? { code: "INTERNAL", message: "Something went wrong." },
    );
  }

  return envelope.value as T;
}

export const api = {
  health: () => call<{ status: string; stores: number }>("GET", "/api/health"),
  getSettings: () => call("GET", "/api/settings"),
  saveOpenRouterKey: (apiKey: string) =>
    call("PUT", "/api/settings/openrouter-key", { apiKey }),
  saveStripeKey: (secretKey: string) =>
    call("PUT", "/api/settings/stripe-key", { secretKey }),
  saveDeployToken: (provider: string, token: string) =>
    call("PUT", "/api/settings/deploy-token", { provider, token }),
  deleteSecret: (name: string) => call("DELETE", `/api/settings/secrets/${name}`),
  setBackup: (enabled: boolean, directory: string | null) =>
    call("PUT", "/api/settings/backup", { enabled, directory }),
  previewProduct: (url: string) => call("POST", "/api/stores/preview", { url }),
  listStores: () => call("GET", "/api/stores"),
  createStore: (payload: unknown) => call("POST", "/api/stores", payload),
  regenerateStore: (id: string, config?: unknown) =>
    call("POST", `/api/stores/${id}/regenerate`, config ? { config } : {}),
  deleteStore: (id: string) => call("DELETE", `/api/stores/${id}`),
  deployInstructions: (id: string, provider: string) =>
    call("GET", `/api/deploy/${id}/instructions?provider=${provider}`),
  recordDeployed: (id: string, deployedUrl: string) =>
    call("POST", `/api/deploy/${id}/deployed`, { deployedUrl }),
  license: () => call("GET", "/api/license"),
  runBackup: () => call("POST", "/api/deploy/backup"),
};

export const desktop = {
  chooseDirectory: () => bridge().chooseDirectory(),
  openPath: (target: string) => bridge().openPath(target),
  openExternal: (url: string) => bridge().openExternal(url),
  info: () => bridge().info(),
  onScrapeChallenge: (
    listener: (info: { url: string; kind: string } | null) => void,
  ) => bridge().onScrapeChallenge(listener),
};
