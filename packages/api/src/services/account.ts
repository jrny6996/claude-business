import {
  AppError,
  shouldRefreshEntitlement,
  type EntitlementPayload,
} from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";
import { cloudBaseUrl } from "./cloud-backup.js";
import { verifyEntitlementToken } from "./license-keys.js";

/**
 * The account, from the app's side.
 *
 * Replaces pasting a licence key. The app signs in once with a mailed code,
 * keeps a device token, and fetches its own entitlement from then on — so a
 * subscription renewal, which previously meant a new key in the inbox and a
 * trip to Settings, is now invisible.
 *
 * The fetched entitlement is **signed**, cached, and verified locally, which is
 * what keeps the app working offline. It is trusted until `expiresAt` and
 * refreshed after `refreshAfter`; the gap between those is what lets a laptop
 * be offline for a fortnight without losing premium, while still ensuring a
 * cancellation takes effect without us reaching the machine.
 */
export const ENTITLEMENT_KEY = "account.entitlement";
export const ACCOUNT_EMAIL_KEY = "account.email";

export interface AccountState {
  signedIn: boolean;
  email: string | null;
  tier: "free" | "premium";
  status: EntitlementPayload["status"] | "unknown";
  periodEnd: string | null;
  /** Set when the cached entitlement can no longer be trusted. */
  staleReason?: string;
}

/** Reads the cached entitlement, verifying it every time rather than trusting a flag. */
export function readEntitlement(ctx: AppContext): {
  payload?: EntitlementPayload;
  reason?: string;
} {
  const token = ctx.data.settings.get(ENTITLEMENT_KEY);
  if (!token) return {};

  const check = verifyEntitlementToken(token, {
    ...(ctx.licensePublicKeyPem ? { publicKeyPem: ctx.licensePublicKeyPem } : {}),
    now: nowOf(ctx),
  });

  return check.valid && check.payload
    ? { payload: check.payload }
    : {
        ...(check.payload ? { payload: check.payload } : {}),
        ...(check.reason ? { reason: check.reason } : {}),
      };
}

export function getAccountState(ctx: AppContext): AccountState {
  const signedIn = Boolean(ctx.data.settings.readSecret("device_token"));
  const { payload, reason } = readEntitlement(ctx);

  if (!payload) {
    return {
      signedIn,
      email: ctx.data.settings.get(ACCOUNT_EMAIL_KEY),
      tier: "free",
      status: "unknown",
      periodEnd: null,
      ...(reason ? { staleReason: reason } : {}),
    };
  }

  return {
    signedIn,
    email: payload.email,
    // A stale entitlement grants nothing; `reason` explains why to the user.
    tier: reason ? "free" : payload.tier,
    status: payload.status,
    periodEnd: payload.periodEnd,
    ...(reason ? { staleReason: reason } : {}),
  };
}

async function cloudRequest(
  ctx: AppContext,
  method: string,
  path: string,
  init: { body?: unknown; token?: string } = {},
): Promise<unknown> {
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as typeof fetch);
  if (typeof fetchImpl !== "function") {
    throw new AppError("FETCH_FAILED", "No network client is available.");
  }

  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = (await (fetchImpl as unknown as (u: string, i: unknown) => Promise<typeof response>)(
      `${cloudBaseUrl(ctx)}${path}`,
      {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
    ));
  } catch {
    throw new AppError(
      "FETCH_FAILED",
      "Couldn't reach the subscription service. Check your connection.",
    );
  }

  const raw = await response.text();
  const parsed = (() => {
    try {
      return JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    } catch {
      return null;
    }
  })();

  if (!response.ok || !parsed?.ok) {
    throw new AppError(
      response.status === 401 ? "UNAUTHORIZED" : "FETCH_FAILED",
      parsed?.error?.message ?? "The subscription service couldn't complete that.",
    );
  }

  return parsed.value;
}

/** Step one: ask for a code. Deliberately reveals nothing about the address. */
export async function requestSigninCode(
  ctx: AppContext,
  email: string,
): Promise<{ message: string }> {
  const trimmed = email.trim();
  if (!trimmed) {
    throw new AppError("VALIDATION_FAILED", "Enter the email address you subscribed with.");
  }

  const value = (await cloudRequest(ctx, "POST", "/api/account/signin", {
    body: { email: trimmed },
  })) as { message?: string };

  return { message: value.message ?? "Check your email for a sign-in code." };
}

/** Step two: exchange the code for a device token and a first entitlement. */
export async function verifySigninCode(
  ctx: AppContext,
  email: string,
  code: string,
): Promise<AccountState> {
  const value = (await cloudRequest(ctx, "POST", "/api/account/verify", {
    body: { email: email.trim(), code: code.trim() },
  })) as { deviceToken?: string; entitlement?: string };

  if (!value.deviceToken || !value.entitlement) {
    throw new AppError("INTERNAL", "The subscription service sent an unexpected reply.");
  }

  const now = nowOf(ctx).toISOString();
  ctx.data.settings.writeSecret("device_token", value.deviceToken, now);
  ctx.data.settings.set(ENTITLEMENT_KEY, value.entitlement, now);
  ctx.data.settings.set(ACCOUNT_EMAIL_KEY, email.trim().toLowerCase(), now);

  return getAccountState(ctx);
}

/**
 * Fetches a fresh entitlement.
 *
 * `force` is for the Settings button; without it this is a no-op until the
 * cached one asks to be refreshed, so it can be called freely on startup.
 */
export async function refreshEntitlement(
  ctx: AppContext,
  { force = false }: { force?: boolean } = {},
): Promise<AccountState> {
  const token = ctx.data.settings.readSecret("device_token");
  if (!token) return getAccountState(ctx);

  const { payload } = readEntitlement(ctx);
  if (!force && payload && !shouldRefreshEntitlement(payload, nowOf(ctx))) {
    return getAccountState(ctx);
  }

  try {
    const value = (await cloudRequest(ctx, "GET", "/api/account/entitlement", {
      token,
    })) as { entitlement?: string };

    if (value.entitlement) {
      ctx.data.settings.set(ENTITLEMENT_KEY, value.entitlement, nowOf(ctx).toISOString());
    }
  } catch (cause) {
    // A signed-out device is the one failure worth acting on; anything else is
    // probably the network, and the cached entitlement is still good until it
    // expires. Throwing here would make the app unusable offline.
    if (cause instanceof AppError && cause.code === "UNAUTHORIZED") {
      await signOut(ctx);
      throw cause;
    }
    if (force) throw cause;
  }

  return getAccountState(ctx);
}

/** Signs this device out, locally and on the service. */
export async function signOut(ctx: AppContext): Promise<AccountState> {
  const token = ctx.data.settings.readSecret("device_token");

  ctx.data.settings.deleteSecret("device_token");
  ctx.data.settings.set(ENTITLEMENT_KEY, "", nowOf(ctx).toISOString());

  if (token) {
    try {
      await cloudRequest(ctx, "DELETE", "/api/account/device", { token });
    } catch {
      // Local sign-out already happened; the token expires on the service side
      // regardless, and failing here would leave the UI saying "still signed in".
    }
  }

  return getAccountState(ctx);
}
