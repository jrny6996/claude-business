import { createHash } from "node:crypto";

/**
 * Where an account's backups live.
 *
 * Both hops are kept purely for continuity. Backups were originally namespaced
 * by a licence id derived from the Stripe subscription, and that licence system
 * is gone — but the blobs are still under those prefixes, so the derivation has
 * to survive it. Changing either function orphans every existing backup.
 */
export function licenseIdForSubscription(subscriptionId: string): string {
  const digest = createHash("sha256")
    .update(`dsv-license:${subscriptionId}`)
    .digest("hex");
  return `lic_${digest.slice(0, 16)}`;
}

export function accountNamespace(licenseId: string): string {
  return createHash("sha256").update(`dsv-account:${licenseId}`).digest("hex");
}

/** The namespace for a subscription, in one step. */
export function backupNamespaceForSubscription(subscriptionId: string): string {
  return accountNamespace(licenseIdForSubscription(subscriptionId));
}
