import { AppError } from "@repo/shared";

/**
 * Injectable fetch so tests never touch the network and the Electron main
 * process can supply its own instrumented implementation.
 */
export type FetchLike = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  text(): Promise<string>;
}>;

export interface FetchPageOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries for transient failures (network errors, 429, 5xx). */
  retries?: number;
  /** Redirect hops to follow before giving up. */
  maxRedirects?: number;
  /** Injected for tests so retry backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_REDIRECTS = 10;

/**
 * A desktop browser UA. AliExpress serves a stripped page to unknown clients,
 * which is the single most common cause of an empty scrape.
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Pins region, currency and locale up front.
 *
 * Without these AliExpress redirects a fresh client through its regional
 * gateway to set them, and that hop lands on a cookie-sync pair that a client
 * with no cookie jar will bounce between until it exhausts its redirect budget.
 */
const REGION_COOKIES: Record<string, string> = {
  aep_usuc_f: "site=glo&c_tp=USD&region=US&b_locale=en_US",
  intl_locale: "en_US",
};

export interface FetchedPage {
  html: string;
  /** Final URL after redirects — short links resolve to the real item here. */
  finalUrl: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal cookie jar: enough to survive a redirect chain, nothing more. */
class CookieJar {
  readonly #jar = new Map<string, string>(Object.entries(REGION_COOKIES));

  absorb(headers: { getSetCookie?(): string[]; get(name: string): string | null }): void {
    const lines =
      headers.getSetCookie?.() ??
      (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);

    for (const line of lines) {
      const pair = line.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx > 0) {
        this.#jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.#jar].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

/**
 * Fetches a product page, following redirects itself so cookies set mid-chain
 * are carried forward, and retrying transient failures.
 *
 * Never throws a raw network error: everything surfaces as an {@link AppError}
 * whose message distinguishes a timeout from a dead link from a redirect loop,
 * because "check your connection" is actively misleading for the latter two.
 */
export async function fetchPage(
  url: string,
  {
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    sleep = defaultSleep,
  }: FetchPageOptions = {},
): Promise<FetchedPage> {
  if (typeof fetchImpl !== "function") {
    throw new AppError("FETCH_FAILED", "No network client is available.");
  }

  let lastStatus: number | undefined;
  let lastFailure: "network" | "timeout" | "redirect-loop" = "network";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));

    const jar = new CookieJar();
    let current = url;
    let redirected = 0;

    try {
      for (;;) {
        const response = await withTimeout(
          (signal) =>
            fetchImpl(current, {
              headers: { ...BROWSER_HEADERS, Cookie: jar.header() },
              redirect: "manual",
              signal,
            }),
          timeoutMs,
        );

        jar.absorb(response.headers);

        const location =
          response.status >= 300 && response.status < 400
            ? response.headers.get("location")
            : null;

        if (location) {
          if (++redirected > maxRedirects) {
            lastFailure = "redirect-loop";
            break;
          }
          current = new URL(location, current).toString();
          continue;
        }

        if (response.ok) {
          return {
            html: await response.text(),
            finalUrl: response.url || current,
          };
        }

        lastStatus = response.status;
        if (!isRetryable(response.status)) {
          throw httpError(response.status);
        }
        break;
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      lastFailure = cause instanceof TimeoutError ? "timeout" : "network";
      lastStatus = undefined;
    }
  }

  if (lastStatus !== undefined) throw httpError(lastStatus);

  if (lastFailure === "redirect-loop") {
    throw new AppError(
      "FETCH_FAILED",
      "AliExpress kept redirecting that link without ever serving the product page.",
      "redirect loop",
    );
  }

  throw new AppError(
    "FETCH_FAILED",
    lastFailure === "timeout"
      ? "That product page took too long to respond. Try again."
      : "Couldn't reach AliExpress. Check your connection and try again.",
    lastFailure,
  );
}

class TimeoutError extends Error {}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await run(controller.signal);
  } catch (cause) {
    throw timedOut ? new TimeoutError() : cause;
  } finally {
    clearTimeout(timer);
  }
}

function httpError(status: number): AppError {
  return new AppError(
    "FETCH_FAILED",
    status === 404
      ? "That product page no longer exists on AliExpress."
      : status === 403 || status === 429
        ? "AliExpress refused that request. It may be rate-limiting this machine."
        : "AliExpress returned an error for that product page.",
    `HTTP ${status}`,
  );
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
