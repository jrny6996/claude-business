import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for signing S3 requests.
 *
 * Hand-rolled rather than pulling in `@aws-sdk/client-s3`, for the same reasons
 * Stripe, OpenRouter, Gemini and Resend are hand-rolled here: it is one
 * authenticated HTTP call, the SDK is several megabytes of cold start in a
 * function that should stay small, and a dependency-free signer works against
 * *any* S3-compatible endpoint — Cloudflare R2, Backblaze B2, MinIO — not just
 * AWS. That portability matters now that we pay for this storage: R2 in
 * particular charges nothing for egress, which a restore-heavy backup service
 * feels directly.
 *
 * A signing bug fails closed — the provider rejects the request — so the
 * failure direction is "backups stop working", never "backups leak". The
 * implementation is checked against AWS's own published test vector.
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for temporary credentials; adds `x-amz-security-token`. */
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** Absolute URL, including any query string. */
  url: string;
  /**
   * Headers to sign. `host` and `x-amz-date` are added automatically.
   *
   * `x-amz-content-sha256` is *not*: it is an S3 requirement rather than a
   * SigV4 one, so the S3 client sets it. Forcing it in here would change the
   * signed-header set for every service and make this untestable against AWS's
   * own published vectors.
   */
  headers?: Record<string, string>;
  /** Raw body, or undefined for a body-less request. */
  body?: Uint8Array;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** Injected so signatures are reproducible in tests. */
  now?: Date;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

export function signRequest({
  method,
  url,
  headers = {},
  body,
  region,
  service,
  credentials,
  now = new Date(),
}: SignRequestInput): SignedRequest {
  const parsed = new URL(url);
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  // The caller may pre-compute this — S3 requires it as a header, and sending
  // the same hash twice from two places is how they drift apart.
  const payloadHash =
    headers["x-amz-content-sha256"] ?? sha256Hex(body ?? new Uint8Array());

  const allHeaders: Record<string, string> = {
    ...headers,
    host: parsed.host,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken
      ? { "x-amz-security-token": credentials.sessionToken }
      : {}),
  };

  const canonical = canonicalHeaders(allHeaders);
  const signedHeaders = canonical.names.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQueryString(parsed.searchParams),
    canonical.block,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signature = hmac(
    signingKey(credentials.secretAccessKey, dateStamp, region, service),
    stringToSign,
  ).toString("hex");

  return {
    url,
    method: method.toUpperCase(),
    headers: {
      ...allHeaders,
      Authorization:
        `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** `20150830T123600Z` */
export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The canonical path.
 *
 * Each segment is percent-encoded, but `/` separators are preserved. S3 is the
 * one service that does *not* double-encode here — doing so is a classic way to
 * produce signatures that verify for simple keys and fail the moment a key
 * contains a character needing an escape.
 */
export function canonicalUri(pathname: string): string {
  if (pathname === "") return "/";
  return pathname
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

/** Sorted by key, then value; both percent-encoded. */
export function canonicalQueryString(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of params) pairs.push([key, value]);

  pairs.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));

  return pairs
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): {
  block: string;
  names: string[];
} {
  const normalised = new Map<string, string>();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    // Header values are trimmed and internal runs of whitespace collapsed.
    normalised.set(name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, " "));
  }

  const names = [...normalised.keys()].sort(compare);
  const block = names.map((name) => `${name}:${normalised.get(name)}\n`).join("");

  return { block, names };
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone, which AWS expects encoded, and it
 * escapes `~`, which AWS expects literal. Both differences produce signature
 * mismatches only for keys containing those characters — the kind of bug that
 * passes every test written with simple filenames.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, "~");
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Byte-order comparison; `localeCompare` would order differently. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
