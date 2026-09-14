import type { FetchLike } from "../scrape/fetch.js";

/**
 * The one HTTP call every AI provider makes.
 *
 * Deliberately provider-neutral and deliberately *not* an `AppError`: each
 * client maps status codes to its own error codes and its own wording, because
 * "your key was rejected" reads differently depending on whose dashboard the
 * user has to go and look at. This layer only knows how to send bytes and time
 * out.
 */
export interface AiHttpOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class AiHttpError extends Error {
  /** null when the request never got a response at all. */
  readonly status: number | null;
  readonly body: string;

  constructor(status: number | null, body: string) {
    super(status === null ? "network error" : `HTTP ${status}`);
    this.name = "AiHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Minimal shape we actually use, so tests can supply a two-field stub. */
type MinimalFetch = (
  input: string,
  init: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function requestText(
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: unknown;
  },
  { fetchImpl, timeoutMs = 60_000 }: AiHttpOptions = {},
): Promise<string> {
  const impl = (fetchImpl ?? globalThis.fetch) as unknown as MinimalFetch;
  if (typeof impl !== "function") {
    throw new AiHttpError(null, "no network client available");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await impl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new AiHttpError(response.status, text);
    return text;
  } catch (cause) {
    if (cause instanceof AiHttpError) throw cause;
    throw new AiHttpError(null, "");
  } finally {
    clearTimeout(timer);
  }
}
