import { AppError } from "@repo/shared";

/**
 * Injectable fetch so tests never touch the network and the Electron main
 * process can supply its own instrumented implementation.
 */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; redirect?: "follow" | "manual"; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
}>;

export interface FetchPageOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries for transient failures (network errors, 429, 5xx). */
  retries?: number;
  /** Injected for tests so retry backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

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

export interface FetchedPage {
  html: string;
  /** Final URL after redirects — short links resolve to the real item here. */
  finalUrl: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches a product page, retrying transient failures.
 *
 * Never throws a raw network error: everything surfaces as an {@link AppError}
 * with `FETCH_FAILED` so the UI can say something useful instead of leaking a
 * stack trace about sockets.
 */
export async function fetchPage(
  url: string,
  {
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    sleep = defaultSleep,
  }: FetchPageOptions = {},
): Promise<FetchedPage> {
  if (typeof fetchImpl !== "function") {
    throw new AppError("FETCH_FAILED", "No network client is available.");
  }

  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });

      if (response.ok) {
        return { html: await response.text(), finalUrl: response.url || url };
      }

      lastStatus = response.status;
      if (!isRetryable(response.status)) break;
    } catch {
      // Network error or timeout — retryable until we run out of attempts.
      lastStatus = undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AppError(
    "FETCH_FAILED",
    lastStatus === 404
      ? "That product page no longer exists on AliExpress."
      : "Couldn't reach that product page. Check your connection and try again.",
    lastStatus === undefined ? "network error" : `HTTP ${lastStatus}`,
  );
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
