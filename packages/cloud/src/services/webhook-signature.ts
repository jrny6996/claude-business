import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signature verification.
 *
 * This is the boundary that decides whether an unauthenticated POST from the
 * open internet is allowed to mint a licence. Everything about it is therefore
 * deliberate:
 *
 * - The signature covers the **raw request body**. Parsing the JSON first and
 *   re-serialising it changes bytes and breaks verification — which is exactly
 *   the sort of thing someone "tidies up" later, so the route reads
 *   `await c.req.text()` and never `c.req.json()`.
 * - Comparison is timing-safe. A byte-at-a-time compare leaks the expected
 *   signature to anyone willing to measure.
 * - Old signatures are rejected on a timestamp tolerance, so a captured
 *   request can't be replayed indefinitely.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureCheck {
  valid: boolean;
  /** Why it failed. Logged, never returned to the caller. */
  reason?: string;
}

/** Parses `t=1699999999,v1=abc...`, tolerating extra schemes and whitespace. */
export function parseSignatureHeader(
  header: string,
): { timestamp: number | null; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) continue;

    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      timestamp = Number.isFinite(parsed) ? parsed : null;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

export function verifyStripeSignature({
  rawBody,
  header,
  secret,
  now,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: {
  rawBody: string;
  header: string | null | undefined;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): SignatureCheck {
  if (!secret) {
    return { valid: false, reason: "no webhook secret configured" };
  }
  if (!header) {
    return { valid: false, reason: "missing Stripe-Signature header" };
  }

  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null) {
    return { valid: false, reason: "no timestamp in signature header" };
  }
  if (signatures.length === 0) {
    return { valid: false, reason: "no v1 signature in header" };
  }

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: `signature is ${ageSeconds}s old` };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  // Stripe may send several v1 signatures during a secret rotation; any match
  // is a pass.
  const matched = signatures.some((candidate) =>
    timingSafeEqualHex(candidate, expected),
  );

  return matched ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

/** Length-checked before comparing: timingSafeEqual throws on a length mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
