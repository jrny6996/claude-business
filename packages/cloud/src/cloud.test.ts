import { createHmac, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKUP_CREATED_AT_HEADER } from "@repo/shared";
import { DEFAULT_CLOUD_CONFIG, type CloudContext } from "./context.js";
import { createCloudApp } from "./index.js";
import { MemoryBlobStore } from "./storage/blobs.js";
import { issueLicense, licenseIdForSubscription } from "./services/issuer.js";
import type { Mailer, OutgoingMail } from "./services/mail.js";
import type {
  StripeApi,
  StripeCheckoutSessionDetails,
  StripeCustomer,
  StripePriceDetails,
  StripeSubscription,
} from "./services/stripe.js";

/** A throwaway issuer keypair — the real one never exists in the repo. */
const issuer = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
})();

const WEBHOOK_SECRET = "whsec_test_secret";
const NOW = new Date("2026-09-08T12:00:00.000Z");
/** Comfortably in the future, so issued licences are live during the test. */
const PERIOD_END = Math.floor(Date.parse("2027-09-08T12:00:00.000Z") / 1000);

class FakeStripe implements StripeApi {
  subscription: StripeSubscription = {
    id: "sub_123",
    status: "active",
    current_period_end: PERIOD_END,
    customer: "cus_123",
  };
  customer: StripeCustomer = { id: "cus_123", email: "buyer@example.com" };
  session: StripeCheckoutSessionDetails = {
    id: "cs_123",
    subscription: "sub_123",
    customer_email: "buyer@example.com",
    status: "complete",
  };
  price: StripePriceDetails = {
    id: "price_123",
    unit_amount: 4900,
    currency: "usd",
    recurring: { interval: "year", interval_count: 1 },
  };
  byEmail: StripeSubscription[] = [];
  readonly created: unknown[] = [];

  async createSubscriptionCheckout(input: unknown) {
    this.created.push(input);
    return { id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" };
  }
  async getSubscription() {
    return this.subscription;
  }
  async getCheckoutSession() {
    return this.session;
  }
  async getCustomer() {
    return this.customer;
  }
  async getPrice() {
    return this.price;
  }
  async findActiveSubscriptionsByEmail() {
    return this.byEmail;
  }
}

class FakeMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  shouldFail = false;

  async send(mail: OutgoingMail): Promise<void> {
    if (this.shouldFail) throw new Error("provider down");
    this.sent.push(mail);
  }
}

let blobs: MemoryBlobStore;
let stripe: FakeStripe;
let mailer: FakeMailer;
let ctx: CloudContext;
let app: ReturnType<typeof createCloudApp>;

const request = async (
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<{ status: number; payload: any; response: Response }> => {
  const response = await app.fetch(
    new Request(`https://storevalidator.test${path}`, {
      method,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.headers ? { headers: init.headers } : {}),
    }),
  );
  const clone = response.clone();
  const payload = await clone.json().catch(() => null);
  return { status: response.status, payload, response };
};

/** A valid premium licence for the fake subscription. */
const premiumKey = (over: { periodEnd?: number; email?: string } = {}): string =>
  issueLicense(
    {
      email: over.email ?? "buyer@example.com",
      subscriptionId: "sub_123",
      periodEnd: over.periodEnd ?? PERIOD_END,
      issuedAt: NOW,
    },
    issuer.privateKeyPem,
  ).key;

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

/** Signs a webhook body the way Stripe does. */
function stripeSignature(body: string, at: Date = NOW, secret = WEBHOOK_SECRET) {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

const eventBody = (type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id: "evt_1", type, data: { object } });

beforeEach(() => {
  blobs = new MemoryBlobStore();
  stripe = new FakeStripe();
  mailer = new FakeMailer();

  ctx = {
    config: {
      ...DEFAULT_CLOUD_CONFIG,
      premiumPriceId: "price_123",
      siteUrl: "https://storevalidator.test",
    },
    blobs,
    stripe,
    mailer,
    licensePrivateKeyPem: issuer.privateKeyPem,
    licensePublicKeyPem: issuer.publicKeyPem,
    stripeWebhookSecret: WEBHOOK_SECRET,
    now: () => NOW,
  };

  app = createCloudApp(ctx);
});

describe("health", () => {
  it("reports what is configured without disclosing any of it", async () => {
    const { status, payload } = await request("GET", "/api/health");

    expect(status).toBe(200);
    expect(payload.value.configured).toEqual({
      stripe: true,
      webhook: true,
      issuer: true,
    });
    expect(JSON.stringify(payload)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(payload)).not.toContain("PRIVATE KEY");
  });
});

describe("checkout", () => {
  it("creates a subscription session against the configured price", async () => {
    const { status, payload } = await request("POST", "/api/checkout", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(status).toBe(200);
    expect(payload.value.url).toContain("checkout.stripe.com");
    expect(stripe.created[0]).toMatchObject({ priceId: "price_123" });
  });

  // The price is deliberately not in the codebase — it lives on the Stripe
  // Price object so it can change without a deploy.
  it("reads the price back from Stripe rather than hardcoding one", async () => {
    const { payload } = await request("GET", "/api/checkout/price");

    expect(payload.value).toEqual({
      amountMinor: 4900,
      currency: "usd",
      interval: "year",
      intervalCount: 1,
    });
  });
});

describe("stripe webhook", () => {
  const body = () =>
    eventBody("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });

  it("issues and emails a licence on a completed checkout", async () => {
    const raw = body();
    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    expect(status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("buyer@example.com");
    expect(mailer.sent[0]?.text).toContain(".");
  });

  it("refuses an unsigned request", async () => {
    const { status } = await request("POST", "/api/stripe/webhook", { body: body() });

    expect(status).toBe(401);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a signature made with the wrong secret", async () => {
    const raw = body();
    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw, NOW, "whsec_wrong") },
    });

    expect(status).toBe(401);
    expect(mailer.sent).toHaveLength(0);
  });

  // The signature covers the exact bytes; a tampered body must not verify even
  // though the header is otherwise well-formed.
  it("refuses a body altered after signing", async () => {
    const raw = body();
    const signature = stripeSignature(raw);
    const tampered = eventBody("checkout.session.completed", {
      subscription: "sub_evil",
      customer_email: "attacker@example.com",
    });

    const { status } = await request("POST", "/api/stripe/webhook", {
      body: tampered,
      headers: { "stripe-signature": signature },
    });

    expect(status).toBe(401);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a replayed request outside the tolerance window", async () => {
    const raw = body();
    const old = new Date(NOW.getTime() - 10 * 60 * 1000);

    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw, old) },
    });

    expect(status).toBe(401);
  });

  it("never explains why a signature failed", async () => {
    const { payload } = await request("POST", "/api/stripe/webhook", {
      body: body(),
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });

    expect(JSON.stringify(payload)).not.toMatch(/timestamp|mismatch|old/i);
  });

  it("issues nothing for a subscription that isn't paying", async () => {
    stripe.subscription = { ...stripe.subscription, status: "past_due" };
    const raw = body();

    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    expect(status).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });

  it("re-issues on renewal with the same licence id and a later expiry", async () => {
    const first = body();
    await request("POST", "/api/stripe/webhook", {
      body: first,
      headers: { "stripe-signature": stripeSignature(first) },
    });

    const laterEnd = PERIOD_END + 365 * 24 * 60 * 60;
    stripe.subscription = { ...stripe.subscription, current_period_end: laterEnd };

    const renewal = eventBody("invoice.paid", { subscription: "sub_123" });
    await request("POST", "/api/stripe/webhook", {
      body: renewal,
      headers: { "stripe-signature": stripeSignature(renewal) },
    });

    expect(mailer.sent).toHaveLength(2);

    // The key is the one line shaped `<base64url>.<base64url>` — the prose
    // around it contains full stops too.
    const decode = (mail: OutgoingMail) => {
      const key = mail.text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(line));
      expect(key).toBeDefined();
      return JSON.parse(
        Buffer.from(key!.split(".")[0]!, "base64url").toString("utf8"),
      ) as { id: string; expiresAt: string };
    };

    const [a, b] = mailer.sent.map(decode);
    // Same identity across renewals, or a subscriber's cloud backups — which
    // are namespaced by licence id — would be orphaned once a year.
    expect(a!.id).toBe(b!.id);
    expect(Date.parse(b!.expiresAt)).toBeGreaterThan(Date.parse(a!.expiresAt));
  });

  // A cancelled subscriber has already paid for the current period.
  it("does not revoke anything on cancellation", async () => {
    const raw = eventBody("customer.subscription.deleted", { id: "sub_123" });

    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    expect(status).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });

  it("still succeeds when the email provider is down", async () => {
    mailer.shouldFail = true;
    const raw = body();

    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    // The payment succeeded; retrying the event would re-issue a licence that
    // already exists, and the buyer can recover the key anyway.
    expect(status).toBe(200);
  });
});

describe("licence recovery", () => {
  it("emails the current licence to a subscriber", async () => {
    stripe.byEmail = [stripe.subscription];

    const { status } = await request("POST", "/api/license/recover", {
      body: JSON.stringify({ email: "buyer@example.com" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  // Otherwise this endpoint answers "does this person use the product?" for
  // anyone who asks.
  it("answers identically for an address that never bought anything", async () => {
    stripe.byEmail = [];

    const known = await request("POST", "/api/license/recover", {
      body: JSON.stringify({ email: "nobody@example.com" }),
      headers: { "Content-Type": "application/json" },
    });

    stripe.byEmail = [stripe.subscription];
    const buyer = await request("POST", "/api/license/recover", {
      body: JSON.stringify({ email: "buyer@example.com" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(known.status).toBe(buyer.status);
    expect(known.payload).toEqual(buyer.payload);
  });

  it("returns the key for a just-completed checkout", async () => {
    const { status, payload } = await request(
      "GET",
      "/api/license/complete?session_id=cs_123",
    );

    expect(status).toBe(200);
    expect(payload.value.status).toBe("ready");
    expect(payload.value.key).toContain(".");
    expect(payload.value.email).toBe("buyer@example.com");
  });

  it("reports pending while Stripe is still creating the subscription", async () => {
    stripe.session = { ...stripe.session, subscription: null };

    const { payload } = await request(
      "GET",
      "/api/license/complete?session_id=cs_123",
    );

    expect(payload.value).toMatchObject({ status: "pending", key: null });
  });
});

describe("backup auth", () => {
  it("refuses an unauthenticated request", async () => {
    const { status, payload } = await request("GET", "/api/backup");

    expect(status).toBe(401);
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses a forged licence", async () => {
    const { publicKey: _p, privateKey } = generateKeyPairSync("ed25519");
    const forged = issueLicense(
      {
        email: "attacker@example.com",
        subscriptionId: "sub_evil",
        periodEnd: PERIOD_END,
        issuedAt: NOW,
      },
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ).key;

    const { status } = await request("GET", "/api/backup", { headers: auth(forged) });
    expect(status).toBe(401);
  });

  it("refuses an expired licence", async () => {
    const expired = premiumKey({
      periodEnd: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
    });

    const { status } = await request("GET", "/api/backup", { headers: auth(expired) });
    expect(status).toBe(401);
  });

  it("refuses a licence whose payload was tampered with", async () => {
    const key = premiumKey();
    const [payloadPart, signature] = key.split(".");
    const decoded = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8"),
    );
    decoded.expiresAt = "2099-01-01T00:00:00.000Z";
    const swapped = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    const { status } = await request("GET", "/api/backup", { headers: auth(swapped) });
    expect(status).toBe(401);
  });
});

describe("backups", () => {
  const upload = (bytes: Uint8Array, key = premiumKey()) =>
    request("POST", "/api/backup", {
      body: bytes as unknown as BodyInit,
      headers: {
        ...auth(key),
        "Content-Type": "application/octet-stream",
        [BACKUP_CREATED_AT_HEADER]: "2026-09-08T11:00:00.000Z",
      },
    });

  it("stores and lists a backup", async () => {
    const { status, payload } = await upload(new Uint8Array([1, 2, 3, 4]));

    expect(status).toBe(200);
    expect(payload.value.backup.sizeBytes).toBe(4);

    const list = await request("GET", "/api/backup", { headers: auth(premiumKey()) });
    expect(list.payload.value.backups).toHaveLength(1);
    expect(list.payload.value.quota.usedBytes).toBe(4);
  });

  it("returns the exact bytes it was given", async () => {
    const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const { payload } = await upload(ciphertext);

    const { response } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(premiumKey()) },
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an empty upload", async () => {
    const { status } = await upload(new Uint8Array());
    expect(status).toBe(400);
  });

  it("refuses an upload over the size limit", async () => {
    ctx.config.maxUploadBytes = 8;
    const { status, payload } = await upload(new Uint8Array(64));

    expect(status).toBe(413);
    expect(payload.error.message).toMatch(/local folder/i);
  });

  it("prunes the oldest backup once retention is reached", async () => {
    ctx.config.maxBackups = 3;

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Distinct upload timestamps, so ordering is well-defined.
      ctx.now = () => new Date(NOW.getTime() + i * 1000);
      const { payload } = await upload(new Uint8Array([i + 1]));
      ids.push(payload.value.backup.id);
    }

    ctx.now = () => new Date(NOW.getTime() + 9000);
    const { payload } = await upload(new Uint8Array([9]));

    expect(payload.value.pruned).toEqual([ids[0]]);

    const list = await request("GET", "/api/backup", { headers: auth(premiumKey()) });
    expect(list.payload.value.backups).toHaveLength(3);
    expect(list.payload.value.backups.map((b: { id: string }) => b.id)).not.toContain(
      ids[0],
    );
  });

  it("refuses an upload that would exceed the quota", async () => {
    ctx.config.quotaBytes = 10;
    ctx.config.maxBackups = 10;

    await upload(new Uint8Array(8));
    const { status, payload } = await upload(new Uint8Array(8));

    expect(status).toBe(507);
    expect(payload.error.code).toBe("QUOTA_EXCEEDED");
  });

  it("deletes a backup", async () => {
    const { payload } = await upload(new Uint8Array([1, 2, 3]));

    const removed = await request(
      "DELETE",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(premiumKey()) },
    );

    expect(removed.status).toBe(200);
    expect(removed.payload.value.backups).toHaveLength(0);
    expect(blobs.totalBytes).toBe(0);
  });

  it("404s a backup that doesn't exist", async () => {
    const { status } = await request("GET", "/api/backup/nope", {
      headers: auth(premiumKey()),
    });
    expect(status).toBe(404);
  });

  it("rejects a traversal attempt in the id", async () => {
    const { status } = await request("DELETE", "/api/backup/..%2F..%2Fetc", {
      headers: auth(premiumKey()),
    });
    expect(status).toBe(400);
  });

  // The blob key is derived from the caller's own licence, so an id belonging
  // to someone else simply isn't addressable.
  it("cannot reach another account's backup", async () => {
    const { payload } = await upload(new Uint8Array([1, 2, 3]));

    const otherKey = issueLicense(
      {
        email: "other@example.com",
        subscriptionId: "sub_other",
        periodEnd: PERIOD_END,
        issuedAt: NOW,
      },
      issuer.privateKeyPem,
    ).key;

    const { status } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(otherKey) },
    );

    expect(status).toBe(404);
  });

  // The whole justification for us paying to store this.
  it("stores nothing that identifies a person", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    const entries = await blobs.list("");
    expect(entries).toHaveLength(1);

    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain("buyer@example.com");
    expect(serialised).not.toContain(licenseIdForSubscription("sub_123"));
    expect(serialised).not.toContain("sub_123");
  });
});

describe("licenseIdForSubscription", () => {
  it("is stable for a subscription and distinct between subscriptions", () => {
    expect(licenseIdForSubscription("sub_123")).toBe(
      licenseIdForSubscription("sub_123"),
    );
    expect(licenseIdForSubscription("sub_123")).not.toBe(
      licenseIdForSubscription("sub_456"),
    );
  });

  it("does not embed the Stripe id it came from", () => {
    expect(licenseIdForSubscription("sub_123")).not.toContain("sub_123");
  });
});
