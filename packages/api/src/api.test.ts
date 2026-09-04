import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aes256GcmCipher, createDataLayer, type DataLayer } from "@repo/db";
import type { FetchLike } from "@repo/store-generator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createApp } from "./index.js";

const PRODUCT_HTML = `<!doctype html><html><head>
<script>
window.runParams = {
  "data": {
    "titleComponent": { "subject": "Wireless Earbuds Pro" },
    "imageComponent": { "imagePathList": ["//ae01.alicdn.com/kf/a.jpg"] },
    "priceComponent": {
      "discountPrice": { "minActivityAmount": { "value": 18.99, "currency": "USD" } }
    }
  }
};
</script></head><body></body></html>`;

/**
 * One fake fetch standing in for AliExpress, OpenRouter and Stripe, so the
 * whole API can be exercised without a network or a real key anywhere.
 */
function fakeFetch(): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];

  const fetchImpl = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push(url);
    // Shaped like a real Response: `fetchPage` follows redirects itself now, so
    // it reads `location` and accumulates cookies from the headers.
    const reply = (payload: unknown, ok = true, status = 200) => ({
      ok,
      status,
      url,
      headers: {
        get: (name: string) => (name.toLowerCase() === "location" ? null : null),
        getSetCookie: () => [] as string[],
      },
      text: async () =>
        typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    if (url.includes("aliexpress.com")) return reply(PRODUCT_HTML);
    if (url.includes("openrouter.ai/api/v1/key")) return reply({ data: {} });
    if (url.includes("openrouter.ai")) {
      return reply({
        choices: [
          {
            message: {
              content: '{"description":"Rewritten copy.","highlights":["AI bullet"]}',
            },
          },
        ],
      });
    }
    if (url.endsWith("/v1/products")) return reply({ id: "prod_1" });
    if (url.includes("/v1/products?")) return reply({ data: [] });
    if (url.endsWith("/v1/prices")) return reply({ id: "price_1" });
    if (url.endsWith("/v1/payment_links")) {
      return reply({ id: "plink_1", url: "https://buy.stripe.com/live_1" });
    }
    void init;
    return reply({}, false, 404);
  }) as unknown as FetchLike;

  return { fetchImpl, calls };
}

interface Harness {
  ctx: AppContext;
  data: DataLayer;
  storesDir: string;
  request(method: string, path: string, body?: unknown): Promise<{
    status: number;
    payload: { ok: boolean; value?: unknown; error?: { code: string; message: string } };
  }>;
}

let harness: Harness;
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "dsv-api-"));
  const data = createDataLayer(":memory:", new Aes256GcmCipher(randomBytes(32)));
  const { fetchImpl } = fakeFetch();

  const ctx: AppContext = {
    data,
    storesDir: join(tempRoot, "stores"),
    fetchImpl,
    now: () => new Date("2026-09-04T12:00:00.000Z"),
  };

  const app = createApp(ctx);

  harness = {
    ctx,
    data,
    storesDir: ctx.storesDir,
    async request(method, path, body) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "Content-Type": "application/json" };
      }
      const response = await app.fetch(
        new Request(`http://local.invalid${path}`, init),
      );
      return { status: response.status, payload: await response.json() };
    },
  };
});

afterEach(() => {
  harness.data.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("health", () => {
  it("reports ok", async () => {
    const { status, payload } = await harness.request("GET", "/api/health");
    expect(status).toBe(200);
    expect(payload.value).toEqual({ status: "ok", stores: 0 });
  });
});

describe("unknown endpoints", () => {
  it("404s in the standard envelope", async () => {
    const { status, payload } = await harness.request("GET", "/api/nope");
    expect(status).toBe(404);
    expect(payload.ok).toBe(false);
  });
});

describe("settings", () => {
  it("returns secret metadata and never a secret", async () => {
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

    const { payload } = await harness.request("GET", "/api/settings");
    const serialised = JSON.stringify(payload);

    expect(serialised).not.toContain("sk-or-v1-abcd1234");
    expect(serialised).toContain('"last4":"1234"');
  });

  it("validates and stores an OpenRouter key", async () => {
    const { status, payload } = await harness.request(
      "PUT",
      "/api/settings/openrouter-key",
      { apiKey: "sk-or-v1-testkey99" },
    );

    expect(status).toBe(200);
    expect((payload.value as { openRouter: { present: boolean } }).openRouter.present).toBe(
      true,
    );
    expect(harness.data.settings.readSecret("openrouter_api_key")).toBe(
      "sk-or-v1-testkey99",
    );
  });

  it("validates and stores a Stripe key", async () => {
    const { status } = await harness.request("PUT", "/api/settings/stripe-key", {
      secretKey: "sk_test_abcd1234",
    });
    expect(status).toBe(200);
    expect(harness.data.settings.readSecret("stripe_secret_key")).toBe(
      "sk_test_abcd1234",
    );
  });

  it("rejects an empty key with a 400", async () => {
    const { status } = await harness.request("PUT", "/api/settings/stripe-key", {
      secretKey: "",
    });
    expect(status).toBe(400);
  });

  it("deletes a secret", async () => {
    harness.data.settings.writeSecret("deploy_token_vercel", "tok_abcd1234");
    const { status, payload } = await harness.request(
      "DELETE",
      "/api/settings/secrets/deploy_token_vercel",
    );

    expect(status).toBe(200);
    expect(
      (payload.value as { deployTokens: { vercel: { present: boolean } } }).deployTokens
        .vercel.present,
    ).toBe(false);
  });

  it("rejects an unknown secret name", async () => {
    const { status } = await harness.request(
      "DELETE",
      "/api/settings/secrets/not_a_secret",
    );
    expect(status).toBe(400);
  });

  it("gates backup preferences behind premium", async () => {
    const { status, payload } = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: "/tmp/backups",
    });

    expect(status).toBe(402);
    expect(payload.error?.code).toBe("PREMIUM_REQUIRED");
  });
});

describe("licensing", () => {
  it("starts on the free tier", async () => {
    const { payload } = await harness.request("GET", "/api/license");
    expect((payload.value as { tier: string }).tier).toBe("free");
  });

  it("records a premium entitlement and unlocks premium features", async () => {
    await harness.request("PUT", "/api/license", {
      tier: "premium",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    const { payload } = await harness.request("GET", "/api/license");
    expect((payload.value as { tier: string }).tier).toBe("premium");

    const backup = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(backup.status).toBe(200);
  });

  it("treats a lapsed entitlement as free", async () => {
    await harness.request("PUT", "/api/license", {
      tier: "premium",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const { payload } = await harness.request("GET", "/api/license");
    expect((payload.value as { tier: string }).tier).toBe("free");
  });

  it("rejects a malformed expiry", async () => {
    const { status } = await harness.request("PUT", "/api/license", {
      tier: "premium",
      expiresAt: "not-a-date",
    });
    expect(status).toBe(400);
  });
});

describe("product preview", () => {
  it("scrapes without persisting anything", async () => {
    const { status, payload } = await harness.request("POST", "/api/stores/preview", {
      url: "https://www.aliexpress.com/item/1005006123456789.html",
    });

    expect(status).toBe(200);
    expect((payload.value as { title: string }).title).toBe("Wireless Earbuds Pro");
    expect(harness.data.stores.count()).toBe(0);
  });

  it("rejects a non-AliExpress link with a usable message", async () => {
    const { status, payload } = await harness.request("POST", "/api/stores/preview", {
      url: "https://example.com/item/1005006.html",
    });

    expect(status).toBe(400);
    expect(payload.error?.code).toBe("UNSUPPORTED_SOURCE");
  });
});

describe("store creation", () => {
  const baseBody = {
    url: "https://www.aliexpress.com/item/1005006123456789.html",
    config: { storeName: "Sound Lab" },
  };

  it("generates a store on disk", async () => {
    const { status, payload } = await harness.request("POST", "/api/stores", baseBody);
    const result = payload.value as {
      store: { status: string; outputDir: string };
      warnings: { code: string }[];
    };

    expect(status).toBe(200);
    expect(result.store.status).toBe("generated");
    expect(existsSync(join(result.store.outputDir, "src/pages/index.astro"))).toBe(true);
    expect(existsSync(join(result.store.outputDir, "src/data/store.json"))).toBe(true);
  });

  it("warns instead of failing when no Stripe key is set", async () => {
    const { payload } = await harness.request("POST", "/api/stores", baseBody);
    const result = payload.value as {
      store: { config: { checkout: { provider: string } } };
      warnings: { code: string }[];
    };

    expect(result.warnings.map((w) => w.code)).toContain("MISSING_STRIPE_KEY");
    expect(result.store.config.checkout.provider).toBe("none");
  });

  it("provisions Stripe checkout when a key is set", async () => {
    harness.data.settings.writeSecret("stripe_secret_key", "sk_test_abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", baseBody);
    const result = payload.value as {
      store: { config: { checkout: { paymentLinkUrl: string } } };
      warnings: unknown[];
    };

    expect(result.store.config.checkout.paymentLinkUrl).toBe(
      "https://buy.stripe.com/live_1",
    );
    expect(result.warnings).toEqual([]);
  });

  it("warns instead of failing when AI copy is asked for without a key", async () => {
    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiCopy: true,
    });
    const result = payload.value as { warnings: { code: string }[] };

    expect(result.warnings.map((w) => w.code)).toContain("MISSING_OPENROUTER_KEY");
  });

  it("uses the AI rewrite when a key is set", async () => {
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiCopy: true,
    });
    const result = payload.value as { store: { id: string; outputDir: string } };

    const { readFileSync } = await import("node:fs");
    const data = JSON.parse(
      readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
    );
    expect(data.product.description).toBe("Rewritten copy.");
    expect(data.product.highlights).toEqual(["AI bullet"]);
  });

  it("rejects an invalid config with a field-level message", async () => {
    const { status, payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: { storeName: "" },
    });

    expect(status).toBe(400);
    expect(payload.error?.code).toBe("VALIDATION_FAILED");
    expect(payload.error?.message).toContain("storeName");
  });

  it("lists, fetches and deletes stores", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const list = await harness.request("GET", "/api/stores");
    expect((list.payload.value as unknown[]).length).toBe(1);

    const one = await harness.request("GET", `/api/stores/${id}`);
    expect((one.payload.value as { id: string }).id).toBe(id);

    const removed = await harness.request("DELETE", `/api/stores/${id}`);
    expect(removed.status).toBe(200);

    const missing = await harness.request("GET", `/api/stores/${id}`);
    expect(missing.status).toBe(404);
  });

  it("regenerates an existing store", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const again = await harness.request("POST", `/api/stores/${id}/regenerate`, {});
    expect(again.status).toBe(200);
    expect((again.payload.value as { store: { status: string } }).store.status).toBe(
      "generated",
    );
  });
});

describe("deploy", () => {
  const baseBody = {
    url: "https://www.aliexpress.com/item/1005006123456789.html",
    config: { storeName: "Sound Lab" },
  };

  it("returns BYO-hosting instructions", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const { status, payload } = await harness.request(
      "GET",
      `/api/deploy/${id}/instructions?provider=vercel`,
    );
    const value = payload.value as {
      command: string;
      tokenEnvVar: string;
      tokenPresent: boolean;
    };

    expect(status).toBe(200);
    expect(value.command).toContain("vercel");
    expect(value.tokenEnvVar).toBe("VERCEL_TOKEN");
    expect(value.tokenPresent).toBe(false);
  });

  it("rejects an unknown provider", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const { status } = await harness.request(
      "GET",
      `/api/deploy/${id}/instructions?provider=heroku`,
    );
    expect(status).toBe(400);
  });

  it("records a deployed URL", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const { status, payload } = await harness.request(
      "POST",
      `/api/deploy/${id}/deployed`,
      { deployedUrl: "https://sound-lab.vercel.app" },
    );

    expect(status).toBe(200);
    expect((payload.value as { status: string }).status).toBe("deployed");
  });

  it("rejects a non-URL deployment record", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const { status } = await harness.request("POST", `/api/deploy/${id}/deployed`, {
      deployedUrl: "not a url",
    });
    expect(status).toBe(400);
  });

  it("gates backups behind premium", async () => {
    const { status } = await harness.request("POST", "/api/deploy/backup");
    expect(status).toBe(402);
  });

  it("runs a backup for a premium user", async () => {
    await harness.request("PUT", "/api/license", {
      tier: "premium",
      expiresAt: null,
    });
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });

    const { status, payload } = await harness.request("POST", "/api/deploy/backup");
    expect(status).toBe(200);
    expect((payload.value as { bytes: number }).bytes).toBeGreaterThan(0);
  });
});
