import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_CREATED_AT_HEADER } from "@repo/shared";
import { DEFAULT_CLOUD_CONFIG, type CloudContext } from "./context.js";
import { createCloudApp } from "./index.js";
import { MemoryBlobStore } from "./storage/blobs.js";
import { S3BlobStore } from "./storage/s3.js";
import { createServer, type Server } from "node:http";
import { accountNamespace, licenseIdForSubscription } from "./services/namespaces.js";
import { findAccountByEmail, isPremiumNow } from "./services/accounts.js";
import type { Mailer, OutgoingMail } from "./services/mail.js";
import type {
  StripeApi,
  StripeCheckoutSessionDetails,
  StripeCustomer,
  StripePriceDetails,
  StripeSubscription,
} from "./services/stripe.js";

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

/**
 * Signs in as a premium subscriber and returns the device token.
 *
 * Goes through the real webhook and sign-in routes rather than seeding blobs,
 * so the tests exercise the path a customer actually takes.
 */
const signInPremium = async (
  email = "buyer@example.com",
  subscriptionId = "sub_123",
): Promise<string> => {
  const body = eventBody("checkout.session.completed", {
    subscription: subscriptionId,
    customer_email: email,
  });
  await request("POST", "/api/stripe/webhook", {
    body,
    headers: { "stripe-signature": stripeSignature(body) },
  });

  await request("POST", "/api/account/signin", {
    body: JSON.stringify({ email }),
    headers: { "Content-Type": "application/json" },
  });
  const code = /\b(\d{6})\b/.exec(mailer.sent.at(-1)?.subject ?? "")?.[1];

  const verified = await request("POST", "/api/account/verify", {
    body: JSON.stringify({ email, code }),
    headers: { "Content-Type": "application/json" },
  });
  return verified.payload.value.deviceToken as string;
};

/** Provisioned in beforeEach so existing tests can use it synchronously. */
let premiumToken = "";

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

  it("records the subscription on a completed checkout", async () => {
    const raw = body();
    const { status } = await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    expect(status).toBe(200);
    // Nothing is minted or mailed any more — the app asks for its entitlement,
    // so there is no artefact to deliver.
    expect(mailer.sent).toHaveLength(0);

    const account = await findAccountByEmail(ctx, "buyer@example.com");
    expect(account).toMatchObject({ status: "active", subscriptionId: "sub_123" });
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

  it("records a subscription that isn't paying, without granting it", async () => {
    stripe.subscription = { ...stripe.subscription, status: "incomplete" };
    const raw = body();
    await request("POST", "/api/stripe/webhook", {
      body: raw,
      headers: { "stripe-signature": stripeSignature(raw) },
    });

    const account = await findAccountByEmail(ctx, "buyer@example.com");
    expect(account?.status).toBe("none");
    expect(isPremiumNow(account!, NOW)).toBe(false);
  });

  it("moves the period end on a renewal", async () => {
    const first = body();
    await request("POST", "/api/stripe/webhook", {
      body: first,
      headers: { "stripe-signature": stripeSignature(first) },
    });

    const renewedEnd = Math.floor(Date.parse("2028-09-08T12:00:00.000Z") / 1000);
    stripe.subscription = { ...stripe.subscription, current_period_end: renewedEnd };

    const renewal = eventBody("invoice.paid", { subscription: "sub_123" });
    await request("POST", "/api/stripe/webhook", {
      body: renewal,
      headers: { "stripe-signature": stripeSignature(renewal) },
    });

    const account = await findAccountByEmail(ctx, "buyer@example.com");
    expect(account?.periodEnd?.slice(0, 4)).toBe("2028");
    // The account id is stable across renewals, so backups stay reachable.
    expect(account?.backupNamespace).toBe(
      accountNamespace(licenseIdForSubscription("sub_123")),
    );
  });

  it("records a cancellation without ending the paid period", async () => {
    const first = body();
    await request("POST", "/api/stripe/webhook", {
      body: first,
      headers: { "stripe-signature": stripeSignature(first) },
    });

    stripe.subscription = { ...stripe.subscription, status: "canceled" };
    const cancel = eventBody("customer.subscription.deleted", { id: "sub_123" });
    await request("POST", "/api/stripe/webhook", {
      body: cancel,
      headers: { "stripe-signature": stripeSignature(cancel) },
    });

    const account = await findAccountByEmail(ctx, "buyer@example.com");
    expect(account?.status).toBe("canceled");
    // Still premium: they paid through PERIOD_END, which is in the future.
    expect(isPremiumNow(account!, NOW)).toBe(true);
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

describe("backup auth", () => {
  it("refuses an unauthenticated request", async () => {
    const { status, payload } = await request("GET", "/api/backup");

    expect(status).toBe(401);
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses a token that isn't ours", async () => {
    const { status } = await request("GET", "/api/backup", {
      headers: auth("not-a-real-device-token"),
    });
    expect(status).toBe(401);
  });

  it("refuses a device that has been signed out", async () => {
    const token = await signInPremium();
    await request("DELETE", "/api/account/device", { headers: auth(token) });

    const { status } = await request("GET", "/api/backup", { headers: auth(token) });
    expect(status).toBe(401);
  });

  it("refuses an account whose paid period has ended", async () => {
    // The gate reads live account state, so a lapsed subscription is refused
    // even though the device token itself is still perfectly valid.
    stripe.subscription = {
      ...stripe.subscription,
      status: "canceled",
      current_period_end: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
    };
    const token = await signInPremium();

    const { status, payload } = await request("GET", "/api/backup", {
      headers: auth(token),
    });
    expect(status).toBe(402);
    expect(payload.error.code).toBe("PREMIUM_REQUIRED");
  });
});

describe("backups", () => {
  beforeEach(async () => {
    premiumToken = await signInPremium();
  });

  const upload = (bytes: Uint8Array, key = premiumToken) =>
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

    const list = await request("GET", "/api/backup", { headers: auth(premiumToken) });
    expect(list.payload.value.backups).toHaveLength(1);
    expect(list.payload.value.quota.usedBytes).toBe(4);
  });

  it("returns the exact bytes it was given", async () => {
    const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const { payload } = await upload(ciphertext);

    const { response } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(premiumToken) },
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

    const list = await request("GET", "/api/backup", { headers: auth(premiumToken) });
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
      { headers: auth(premiumToken) },
    );

    expect(removed.status).toBe(200);
    expect(removed.payload.value.backups).toHaveLength(0);
    expect(await blobs.list("backups/")).toHaveLength(0);
  });

  it("404s a backup that doesn't exist", async () => {
    const { status } = await request("GET", "/api/backup/nope", {
      headers: auth(premiumToken),
    });
    expect(status).toBe(404);
  });

  it("rejects a traversal attempt in the id", async () => {
    const { status } = await request("DELETE", "/api/backup/..%2F..%2Fetc", {
      headers: auth(premiumToken),
    });
    expect(status).toBe(400);
  });

  // The blob key is derived from the caller's own licence, so an id belonging
  // to someone else simply isn't addressable.
  it("cannot reach another account's backup", async () => {
    const { payload } = await upload(new Uint8Array([1, 2, 3]));

    const otherKey = await signInPremium("other@example.com", "sub_other");

    const { status } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(otherKey) },
    );

    expect(status).toBe(404);
  });

  // The whole justification for us paying to store this.
  it("stores no identity alongside a backup", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    // Accounts exist now, so the store legitimately holds an email in
    // `accounts/`. What must stay true is that a *backup* — the bulk of what we
    // hold, and the part that would hurt in a breach — carries no identity: not
    // an address, not a subscription id, nothing but ciphertext under an opaque
    // namespace.
    const entries = await blobs.list("backups/");
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

/**
 * The whole backup surface again, this time on S3 rather than the in-memory
 * store.
 *
 * `S3BlobStore` has its own tests, but those prove the *store* works. This
 * proves the *service* works on it — that retention, quota and per-account
 * isolation still hold when the backing store is remote, paginated and
 * eventually returns metadata through a different mechanism. Storage swaps are
 * exactly where an interface turns out to have been leakier than it looked.
 */
describe("backups on S3", () => {
  let s3: Server;
  let objects: Map<string, { body: Buffer; manifest: string | null }>;
  let endpoint: string;

  beforeAll(async () => {
    s3 = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));

      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        res.writeHead(403).end();
        return;
      }

      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200).end(
          `<?xml version="1.0"?><ListBucketResult>${matching
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
        return;
      }

      if (req.method === "PUT") {
        objects.set(key, {
          body,
          manifest: (req.headers["x-amz-meta-manifest"] as string) ?? null,
        });
        res.writeHead(200).end();
        return;
      }

      const found = objects.get(key);
      if (req.method === "GET" || req.method === "HEAD") {
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          ...(found.manifest ? { "x-amz-meta-manifest": found.manifest } : {}),
        });
        res.end(req.method === "HEAD" ? undefined : found.body);
        return;
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });

    await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
    const address = s3.address();
    endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => {
    s3.close();
  });

  beforeEach(() => {
    objects = new Map();
    ctx.blobs = new S3BlobStore({
      bucket: "dsv-backups",
      region: "eu-west-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      endpoint,
      prefix: "store-validator/",
    });
    app = createCloudApp(ctx);
  });

  beforeEach(async () => {
    // Accounts live in the same store, which this suite swaps for S3, so the
    // sign-in has to happen after that swap.
    premiumToken = await signInPremium();
  });

  /** Bucket keys that are backups — account records share the bucket. */
  const backupKeys = () =>
    [...objects.keys()].filter((key) => key.includes("/backups/"));

  const upload = (bytes: Uint8Array, key = premiumToken) =>
    request("POST", "/api/backup", {
      body: bytes as unknown as BodyInit,
      headers: {
        ...auth(key),
        "Content-Type": "application/octet-stream",
        [BACKUP_CREATED_AT_HEADER]: "2026-09-08T11:00:00.000Z",
      },
    });

  it("stores, lists and returns a backup byte for byte", async () => {
    const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const { status, payload } = await upload(ciphertext);
    expect(status).toBe(200);

    const list = await request("GET", "/api/backup", { headers: auth(premiumToken) });
    expect(list.payload.value.backups).toHaveLength(1);
    expect(list.payload.value.quota.usedBytes).toBe(ciphertext.length);

    const { response } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(premiumToken) },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
  });

  // The camelCase manifest fields have to survive S3, which lowercases
  // per-field metadata keys.
  it("preserves the manifest across a real S3 round trip", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    const list = await request("GET", "/api/backup", { headers: auth(premiumToken) });
    const backup = list.payload.value.backups[0];

    expect(backup.createdAt).toBe("2026-09-08T11:00:00.000Z");
    expect(backup.algorithm).toBe("AES-256-GCM");
    expect(backup.sizeBytes).toBe(3);
  });

  it("still prunes to the retention limit", async () => {
    ctx.config.maxBackups = 2;

    for (let i = 0; i < 4; i++) {
      ctx.now = () => new Date(NOW.getTime() + i * 1000);
      await upload(new Uint8Array([i + 1]));
    }

    const list = await request("GET", "/api/backup", { headers: auth(premiumToken) });
    expect(list.payload.value.backups).toHaveLength(2);
    // Pruned objects are really gone from the bucket, not just delisted.
    expect(backupKeys().length).toBe(2);
  });

  it("still keeps accounts apart", async () => {
    const { payload } = await upload(new Uint8Array([1, 2, 3]));

    const other = await signInPremium("other@example.com", "sub_other");

    const cross = await request("GET", `/api/backup/${payload.value.backup.id}`, {
      headers: auth(other),
    });
    expect(cross.status).toBe(404);
  });

  it("puts nothing identifying in the bucket, including the prefix", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    const keys = backupKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^store-validator\/backups\//);
    expect(keys[0]).not.toContain("buyer@example.com");
    expect(keys[0]).not.toContain("sub_123");
  });

  it("surfaces a storage outage rather than reporting success", async () => {
    ctx.blobs = new S3BlobStore({
      bucket: "dsv-backups",
      region: "eu-west-1",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      endpoint: "http://127.0.0.1:1",
    });
    app = createCloudApp(ctx);

    const { status } = await upload(new Uint8Array([1, 2, 3]));
    expect(status).toBe(502);
  });
});

/**
 * Accounts and subscription-driven entitlement.
 *
 * The behaviour these pin down is the reason accounts exist at all: a
 * subscriber should renew and notice nothing, where the licence flow emailed a
 * new key to paste every period.
 */
describe("accounts", () => {
  const signIn = async (email = "buyer@example.com") => {
    await request("POST", "/api/account/signin", {
      body: JSON.stringify({ email }),
      headers: { "Content-Type": "application/json" },
    });

    const code = /\b(\d{6})\b/.exec(mailer.sent.at(-1)?.subject ?? "")?.[1];
    const verified = await request("POST", "/api/account/verify", {
      body: JSON.stringify({ email, code }),
      headers: { "Content-Type": "application/json" },
    });
    return { code, verified };
  };

  /** Drives the webhook the way Stripe would. */
  const webhook = async (type: string, object: Record<string, unknown>) => {
    const body = eventBody(type, object);
    return request("POST", "/api/stripe/webhook", {
      body,
      headers: { "stripe-signature": stripeSignature(body) },
    });
  };

  it("mails a sign-in code and exchanges it for a device token", async () => {
    const { code, verified } = await signIn();

    expect(code).toMatch(/^\d{6}$/);
    expect(verified.status).toBe(200);
    expect(verified.payload.value.deviceToken).toBeTruthy();
    expect(verified.payload.value.entitlement).toMatchObject({
      email: "buyer@example.com",
    });
  });

  it("never says whether an address is a customer", async () => {
    const stranger = await request("POST", "/api/account/signin", {
      body: JSON.stringify({ email: "nobody@example.com" }),
      headers: { "Content-Type": "application/json" },
    });
    const customer = await request("POST", "/api/account/signin", {
      body: JSON.stringify({ email: "buyer@example.com" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(stranger.status).toBe(customer.status);
    expect(stranger.payload).toEqual(customer.payload);
  });

  it("refuses a wrong code, and the same code twice", async () => {
    await request("POST", "/api/account/signin", {
      body: JSON.stringify({ email: "buyer@example.com" }),
      headers: { "Content-Type": "application/json" },
    });
    const code = /\b(\d{6})\b/.exec(mailer.sent.at(-1)?.subject ?? "")?.[1]!;

    const wrong = await request("POST", "/api/account/verify", {
      body: JSON.stringify({ email: "buyer@example.com", code: "000000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(wrong.status).toBe(401);

    const first = await request("POST", "/api/account/verify", {
      body: JSON.stringify({ email: "buyer@example.com", code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(first.status).toBe(200);

    // Single use: a code left in an inbox must not be a standing credential.
    const replay = await request("POST", "/api/account/verify", {
      body: JSON.stringify({ email: "buyer@example.com", code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(replay.status).toBe(401);
  });

  it("reports free before any subscription, premium after the webhook", async () => {
    const { verified } = await signIn();
    const token = verified.payload.value.deviceToken;

    const before = await request("GET", "/api/account/entitlement", { headers: auth(token) });
    expect(before.payload.value.entitlement.tier).toBe("free");

    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });

    const after = await request("GET", "/api/account/entitlement", { headers: auth(token) });
    const entitlement = after.payload.value.entitlement;
    expect(entitlement.tier).toBe("premium");
    expect(entitlement.status).toBe("active");
  });

  it("keeps the same device token working across a renewal", async () => {
    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });
    const { verified } = await signIn();
    const token = verified.payload.value.deviceToken;

    // The renewal moves the period end. Nothing is emailed to paste, and the
    // token the app already holds keeps working — the whole point of accounts.
    stripe.subscription = {
      ...stripe.subscription,
      current_period_end: Math.floor(Date.parse("2028-09-08T12:00:00.000Z") / 1000),
    };
    await webhook("invoice.paid", { subscription: "sub_123" });

    const after = await request("GET", "/api/account/entitlement", { headers: auth(token) });
    expect(after.status).toBe(200);
    const entitlement = after.payload.value.entitlement;
    expect(entitlement.tier).toBe("premium");
    expect(entitlement.periodEnd?.slice(0, 4)).toBe("2028");
  });

  it("keeps a cancelled subscriber premium until the period they paid for ends", async () => {
    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });
    const { verified } = await signIn();
    const token = verified.payload.value.deviceToken;

    stripe.subscription = { ...stripe.subscription, status: "canceled" };
    await webhook("customer.subscription.deleted", { id: "sub_123" });

    const after = await request("GET", "/api/account/entitlement", { headers: auth(token) });
    const entitlement = after.payload.value.entitlement;
    expect(entitlement.status).toBe("canceled");
    // Still premium: they paid through PERIOD_END, which is in the future.
    expect(entitlement.tier).toBe("premium");
  });

  it("drops to free once a cancelled period has actually ended", async () => {
    stripe.subscription = {
      ...stripe.subscription,
      status: "canceled",
      current_period_end: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
    };
    await webhook("customer.subscription.deleted", { id: "sub_123" });

    const { verified } = await signIn();
    const entitlement = verified.payload.value.entitlement;
    expect(entitlement.tier).toBe("free");
  });

  it("signs a device out without affecting the account", async () => {
    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });
    const first = (await signIn()).verified.payload.value.deviceToken;
    const second = (await signIn()).verified.payload.value.deviceToken;

    expect(
      (await request("DELETE", "/api/account/device", { headers: auth(first) })).status,
    ).toBe(200);
    expect(
      (await request("GET", "/api/account/entitlement", { headers: auth(first) })).status,
    ).toBe(401);
    // The other device is untouched.
    expect(
      (await request("GET", "/api/account/entitlement", { headers: auth(second) })).status,
    ).toBe(200);
  });

  it("reaches the same backups from a second device", async () => {
    const first = await signInPremium();

    const upload = await request("POST", "/api/backup", {
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
      headers: {
        ...auth(first),
        [BACKUP_CREATED_AT_HEADER]: NOW.toISOString(),
      },
    });
    expect(upload.status).toBe(200);

    // A different device on the same account: the namespace comes from the
    // subscription, not the token, so the backups are still there.
    const second = await signInPremium();
    expect(second).not.toBe(first);

    const listed = await request("GET", "/api/backup", { headers: auth(second) });
    expect(listed.status).toBe(200);
    expect(listed.payload.value.backups).toHaveLength(1);
  });

});

