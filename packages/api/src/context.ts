import type { DataLayer } from "@repo/db";
import type {
  BinaryFetchLike,
  FetchLike,
  PageSource,
} from "@repo/store-generator";

/**
 * Everything the API needs from its host.
 *
 * The Electron main process builds this once and hands it to `createApp`.
 * Keeping it explicit (rather than reaching for module-level singletons) is
 * what lets the whole API be tested against an in-memory database and a fake
 * fetch, with no Electron in sight.
 */
export interface AppContext {
  data: DataLayer;
  /** Root directory generated stores are written under. */
  storesDir: string;
  /** Injected so tests never hit the network. */
  fetchImpl?: FetchLike;
  /**
   * Binary fetch used to download product images into a generated store.
   * Separate from `fetchImpl` because that one is text-only. Injected so
   * tests never reach a CDN.
   */
  assetFetchImpl?: BinaryFetchLike;
  /**
   * Where product pages are loaded from. The desktop app supplies a Chromium
   * window, because AliExpress renders its product data client-side and blocks
   * plain HTTP clients. Tests leave this unset and use `fetchImpl`.
   */
  pageSource?: PageSource;
  /** Injected so generated output and timestamps are deterministic in tests. */
  now?: () => Date;
  /** Overrides the built-in licence public key. Set by tests. */
  licensePublicKeyPem?: string;
}

export const nowOf = (ctx: AppContext): Date =>
  ctx.now ? ctx.now() : new Date();
