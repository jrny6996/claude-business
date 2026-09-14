import type {
  AiProvider,
  AppErrorShape,
  BackupDestination,
  BackupList,
  BackupUploadResult,
  DevEnvProgress,
  DevEnvStatus,
  SettingsView,
  Store,
} from "@repo/shared";

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
  startPreview(storeId: string, projectDir: string): Promise<{ url: string }>;
  stopPreview(storeId: string): Promise<boolean>;
  previewStatus(storeId: string): Promise<{ url: string } | null>;
  devEnvStatus(storeId: string, projectDir: string): Promise<unknown>;
  devEnvInstall(storeId: string, projectDir: string): Promise<unknown>;
  onDevEnvProgress(listener: (event: DevEnvProgress) => void): () => void;
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

export interface CreateStoreResult {
  store: Store;
  warnings: { code: string; message: string }[];
}

export interface LicenseStatus {
  tier: "free" | "premium";
  expiresAt: string | null;
  license: {
    hint: string;
    email: string;
    valid: boolean;
    reason?: string;
  } | null;
}

/** What the app knows about the signed-in account's subscription. */
export interface AccountState {
  signedIn: boolean;
  email: string | null;
  tier: "free" | "premium";
  status: string;
  periodEnd: string | null;
  /** Set when the cached entitlement is too old to be trusted. */
  staleReason?: string;
}

export interface DeployInstructions {
  provider: string;
  projectDir: string;
  command: string;
  tokenEnvVar: string;
  tokenPresent: boolean;
  needsStripeEnv: boolean;
  notes: string[];
}

export const api = {
  health: () => call<{ status: string; stores: number }>("GET", "/api/health"),
  getSettings: () => call<SettingsView>("GET", "/api/settings"),
  saveAiKey: (provider: AiProvider, apiKey: string) =>
    call<SettingsView>("PUT", "/api/settings/ai-key", { provider, apiKey }),
  setAiPreferences: (provider: AiProvider, model?: string | null) =>
    call<SettingsView>("PUT", "/api/settings/ai", { provider, model }),
  saveStripeKey: (secretKey: string) =>
    call<SettingsView>("PUT", "/api/settings/stripe-key", { secretKey }),
  saveDeployToken: (provider: string, token: string) =>
    call<SettingsView>("PUT", "/api/settings/deploy-token", { provider, token }),
  deleteSecret: (name: string) =>
    call<SettingsView>("DELETE", `/api/settings/secrets/${name}`),
  setBackup: (
    enabled: boolean,
    directory: string | null,
    destination?: BackupDestination,
  ) =>
    call<SettingsView>("PUT", "/api/settings/backup", {
      enabled,
      directory,
      ...(destination ? { destination } : {}),
    }),
  previewProduct: (url: string) => call("POST", "/api/stores/preview", { url }),
  listStores: () => call<Store[]>("GET", "/api/stores"),
  createStore: (payload: unknown) =>
    call<CreateStoreResult>("POST", "/api/stores", payload),
  regenerateStore: (id: string, config?: unknown) =>
    call<CreateStoreResult>(
      "POST",
      `/api/stores/${id}/regenerate`,
      config ? { config } : {},
    ),
  updateTheme: (id: string, theme: unknown) =>
    call<Store>("PUT", `/api/stores/${id}/theme`, { theme }),
  deleteStore: (id: string) => call("DELETE", `/api/stores/${id}`),
  deployInstructions: (id: string, provider: string) =>
    call<DeployInstructions>(
      "GET",
      `/api/deploy/${id}/instructions?provider=${provider}`,
    ),
  recordDeployed: (id: string, deployedUrl: string) =>
    call<Store>("POST", `/api/deploy/${id}/deployed`, { deployedUrl }),
  license: () => call<LicenseStatus>("GET", "/api/license"),
  activateLicense: (key: string) =>
    call<LicenseStatus>("POST", "/api/license/activate", { key }),
  deactivateLicense: () => call<LicenseStatus>("DELETE", "/api/license"),

  // Accounts. A device token replaces pasting a licence each billing period;
  // the app fetches its own entitlement, so a renewal needs no action.
  account: () => call<AccountState>("GET", "/api/account"),
  requestSigninCode: (email: string) =>
    call<{ message: string }>("POST", "/api/account/signin", { email }),
  verifySigninCode: (email: string, code: string) =>
    call<AccountState>("POST", "/api/account/verify", { email, code }),
  refreshAccount: () => call<AccountState>("POST", "/api/account/refresh"),
  signOutAccount: () => call<AccountState>("POST", "/api/account/signout"),
  runBackup: () => call<RunBackupResult>("POST", "/api/deploy/backup"),

  // Cloud backup. The recovery key has its own endpoint so it is only ever
  // sent when the user asks to see it, never on a settings poll.
  recoveryKey: () =>
    call<{ key: string }>("GET", "/api/deploy/backup/recovery-key"),
  setRecoveryKey: (key: string) =>
    call("PUT", "/api/deploy/backup/recovery-key", { key }),
  cloudBackups: () => call<BackupList>("GET", "/api/deploy/backup/cloud"),
  deleteCloudBackup: (id: string) =>
    call<BackupList>("DELETE", `/api/deploy/backup/cloud/${id}`),
  restoreCloudBackup: (id: string) =>
    call<{ path: string; bytes: number; requiresRestart: true }>(
      "POST",
      `/api/deploy/backup/cloud/${id}/restore`,
    ),
};

export interface RunBackupResult {
  local: { path: string; bytes: number; createdAt: string } | null;
  cloud: BackupUploadResult | null;
  failures: { destination: "local" | "cloud"; message: string }[];
}

/**
 * Unwraps the `{ ok, value | error }` envelope the dev-environment IPC handlers
 * return, so a failure surfaces as the same {@link ApiError} the HTTP path
 * produces rather than Electron's "Error invoking remote method" wrapper.
 */
function unwrap<T>(payload: unknown): T {
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

export const desktop = {
  chooseDirectory: () => bridge().chooseDirectory(),
  openPath: (target: string) => bridge().openPath(target),
  openExternal: (url: string) => bridge().openExternal(url),
  info: () => bridge().info(),
  onScrapeChallenge: (
    listener: (info: { url: string; kind: string } | null) => void,
  ) => bridge().onScrapeChallenge(listener),
  startPreview: (storeId: string, projectDir: string) =>
    bridge().startPreview(storeId, projectDir),
  stopPreview: (storeId: string) => bridge().stopPreview(storeId),
  previewStatus: (storeId: string) => bridge().previewStatus(storeId),

  devEnvStatus: async (storeId: string, projectDir: string) =>
    unwrap<DevEnvStatus>(await bridge().devEnvStatus(storeId, projectDir)),
  devEnvInstall: async (storeId: string, projectDir: string) =>
    unwrap<{ storeId: string; packageCount: number | null; status: DevEnvStatus }>(
      await bridge().devEnvInstall(storeId, projectDir),
    ),
  onDevEnvProgress: (listener: (event: DevEnvProgress) => void) =>
    bridge().onDevEnvProgress(listener),
};
