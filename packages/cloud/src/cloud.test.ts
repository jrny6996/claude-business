import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_CREATED_AT_HEADER } from "@repo/shared";
import { DEFAULT_CLOUD_CONFIG, type CloudContext } from "./context.js";
import { createCloudApp } from "./index.js";
import { MemoryBlobStore } from "./storage/blobs.js";
import { S3BlobStore } from "./storage/s3.js";
import { createServer, type Server } from "node:http";
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

  const upload = (bytes: Uint8Array, key = premiumKey()) =>
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

    const list = await request("GET", "/api/backup", { headers: auth(premiumKey()) });
    expect(list.payload.value.backups).toHaveLength(1);
    expect(list.payload.value.quota.usedBytes).toBe(ciphertext.length);

    const { response } = await request(
      "GET",
      `/api/backup/${payload.value.backup.id}`,
      { headers: auth(premiumKey()) },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
  });

  // The camelCase manifest fields have to survive S3, which lowercases
  // per-field metadata keys.
  it("preserves the manifest across a real S3 round trip", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    const list = await request("GET", "/api/backup", { headers: auth(premiumKey()) });
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

    const list = await request("GET", "/api/backup", { headers: auth(premiumKey()) });
    expect(list.payload.value.backups).toHaveLength(2);
    // Pruned objects are really gone from the bucket, not just delisted.
    expect(objects.size).toBe(2);
  });

  it("still keeps accounts apart", async () => {
    const { payload } = await upload(new Uint8Array([1, 2, 3]));

    const other = issueLicense(
      {
        email: "other@example.com",
        subscriptionId: "sub_other",
        periodEnd: PERIOD_END,
        issuedAt: NOW,
      },
      issuer.privateKeyPem,
    ).key;

    const cross = await request("GET", `/api/backup/${payload.value.backup.id}`, {
      headers: auth(other),
    });
    expect(cross.status).toBe(404);
  });

  it("puts nothing identifying in the bucket, including the prefix", async () => {
    await upload(new Uint8Array([1, 2, 3]));

    const keys = [...objects.keys()];
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
    expect(verified.payload.value.entitlement).toContain(".");
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
    expect(payloadOf(before.payload.value.entitlement).tier).toBe("free");

    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });

    const after = await request("GET", "/api/account/entitlement", { headers: auth(token) });
    const entitlement = payloadOf(after.payload.value.entitlement);
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
    const entitlement = payloadOf(after.payload.value.entitlement);
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
    const entitlement = payloadOf(after.payload.value.entitlement);
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
    const entitlement = payloadOf(verified.payload.value.entitlement);
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

  it("accepts a device token for cloud backup, reaching the same namespace as the key", async () => {
    await webhook("checkout.session.completed", {
      subscription: "sub_123",
      customer_email: "buyer@example.com",
    });

    // Uploaded with a licence key, as a pre-accounts customer would have.
    const upload = await request("POST", "/api/backup", {
      body: new Uint8Array([1, 2, 3]),
      headers: {
        ...auth(premiumKey()),
        [BACKUP_CREATED_AT_HEADER]: NOW.toISOString(),
      },
    });
    expect(upload.status).toBe(200);

    // Listed with a device token: same backups, not an empty account.
    const token = (await signIn()).verified.payload.value.deviceToken;
    const listed = await request("GET", "/api/backup", { headers: auth(token) });
    expect(listed.status).toBe(200);
    expect(listed.payload.value.backups).toHaveLength(1);
  });
});

/** Reads a signed entitlement's payload without verifying it. */
function payloadOf(token: string): any {
  return JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  );
}
