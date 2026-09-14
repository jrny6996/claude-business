import { z } from "zod";

/**
 * What an account is currently entitled to, as the service reports it.
 *
 * Deliberately **not** signed. It used to be, along with a whole licence-key
 * subsystem, and that bought nothing: every feature it gated runs on the user's
 * own machine, so anyone determined enough to forge an entitlement could just
 * patch the app. Signing only made casual tampering slightly harder while
 * costing a keypair, a build-time public key, an issuer and ~800 lines.
 *
 * The gate that actually matters is server-side. Cloud backup — the one premium
 * feature we run and pay for — checks live account state on every request and
 * cannot be talked out of it by anything a client sends. Local features are
 * gated for the user's benefit, not as a security boundary.
 *
 * Still cached, because the app must work offline. `expiresAt` bounds how long
 * a cached answer is honoured, so a lapsed subscription stops working without
 * us needing to reach the machine.
 */
export const EntitlementSchema = z.object({
  /** Stable, opaque account id. Derived from the email, never the email itself. */
  accountId: z.string().min(1),
  email: z.email(),
  tier: z.enum(["free", "premium"]),
  /** Mirrors Stripe, so the UI can tell "lapsed" from "payment failed". */
  status: z.enum(["active", "trialing", "past_due", "canceled", "none"]),
  /** End of the paid period, when there is one. */
  periodEnd: z.iso.datetime().nullable(),
  /** When the app should try to refresh. Before `expiresAt`, so it has room. */
  refreshAfter: z.iso.datetime(),
  /** When the app must stop honouring this. */
  expiresAt: z.iso.datetime(),
  issuedAt: z.iso.datetime(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/** Parses a cached or fetched entitlement, or null if it isn't one. */
export function parseEntitlement(value: unknown): Entitlement | null {
  const parsed = EntitlementSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isEntitlementFresh(entitlement: Entitlement, now: Date): boolean {
  return Date.parse(entitlement.expiresAt) > now.getTime();
}

/** Whether the app should go and fetch a newer one. */
export function shouldRefreshEntitlement(
  entitlement: Entitlement,
  now: Date,
): boolean {
  return Date.parse(entitlement.refreshAfter) <= now.getTime();
}

/** Premium only while the answer is still fresh enough to honour. */
export function entitlementTier(
  entitlement: Entitlement | null,
  now: Date,
): "free" | "premium" {
  if (!entitlement || !isEntitlementFresh(entitlement, now)) return "free";
  return entitlement.tier;
}
