import type { AppContext } from "../context.js";

/**
 * Where the hosted service lives.
 *
 * Its own module so `settings.ts` can reach account state without importing
 * `cloud-backup.ts`, which imports `settings.ts` back.
 */
const DEFAULT_CLOUD_URL = "https://storevalidator.app";

export function cloudBaseUrl(ctx: AppContext): string {
  return (ctx.cloudBaseUrl ?? DEFAULT_CLOUD_URL).replace(/\/$/, "");
}
