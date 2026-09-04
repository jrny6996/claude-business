/**
 * Detecting when AliExpress has stopped serving us a product page.
 *
 * Three distinct walls, all of which previously surfaced as "missing title":
 *
 * - `/_____tmd_____/punish?x5secdata=…` — Alibaba's anti-bot interstitial.
 * - `login.aliexpress.*` — the listing needs a signed-in session.
 * - `sync_cookie_read` / `sync_cookie_write` — the cookie handshake between the
 *   global and regional gateways. Harmless in a browser, but a plain HTTP client
 *   with no cookie jar bounces between the two until it runs out of redirects.
 *
 * We never try to defeat any of these. The desktop app shows the page to the
 * user so a human can clear it in their own session.
 */
export type ChallengeKind = "bot" | "login" | "cookie-sync";

const PATTERNS: { kind: ChallengeKind; test: RegExp }[] = [
  { kind: "bot", test: /_____tmd_____\/punish|x5secdata=|\/punish\?/i },
  { kind: "login", test: /^https?:\/\/login\.aliexpress\.[a-z.]+\/(?!sync_cookie)/i },
  { kind: "cookie-sync", test: /sync_cookie_(read|write)/i },
];

export function detectChallenge(url: string): ChallengeKind | null {
  for (const { kind, test } of PATTERNS) {
    if (test.test(url)) return kind;
  }
  return null;
}

/**
 * A rendered page can also carry the wall in its body rather than its URL,
 * e.g. when the interstitial is injected client-side.
 */
export function detectChallengeInHtml(html: string): ChallengeKind | null {
  if (/x5secdata|_____tmd_____|Slide to verify|nc_wrapper/i.test(html)) return "bot";
  return null;
}

export const CHALLENGE_MESSAGES: Record<ChallengeKind, string> = {
  bot: "AliExpress is asking to verify you're human before it will show this listing.",
  login: "AliExpress wants you signed in to view this listing.",
  "cookie-sync": "AliExpress redirected us through its regional gateway.",
};
