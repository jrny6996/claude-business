import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aes256GcmCipher, createDataLayer, type DataLayer } from "@repo/db";
import type { BinaryFetchLike, FetchLike } from "@repo/store-generator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createApp } from "./index.js";
import {
  MemoryBlobStore,
  applySubscriptionState,
  createCloudApp,
  issueSigninCode,
  redeemSigninCode,
  type CloudContext,
} from "@repo/cloud";

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
 * One fake fetch standing in for AliExpress, OpenRouter, Gemini and Stripe, so
 * the whole API can be exercised without a network or a real key anywhere.
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
    if (url.includes("generativelanguage.googleapis.com")) {
      if (url.includes("/models?")) return reply({ models: [] });
      // Unknown models 404, the way Google's API does — so a test that claims
      // to exercise a provider failure actually gets one.
      if (!/\/models\/gemini-[\w.-]+:generateContent/.test(url)) {
        return reply({ error: { status: "NOT_FOUND" } }, false, 404);
      }
      return reply({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"description":"Gemini copy.","highlights":["Gemini bullet"],"alt":["Gemini alt"]}',
                },
              ],
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

/** A one-pixel JPEG, so image downloads in tests never touch a CDN. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function fakeAssetFetch(): {
  assetFetchImpl: BinaryFetchLike;
  calls: string[];
  fail: (url: string) => void;
} {
  const calls: string[] = [];
  const failing = new Set<string>();

  const assetFetchImpl = (async (url: string) => {
    calls.push(url);
    if (failing.has(url)) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "image/jpeg" : null,
      },
      arrayBuffer: async () =>
        JPEG_BYTES.buffer.slice(0, JPEG_BYTES.byteLength) as ArrayBuffer,
    };
  }) as BinaryFetchLike;

  return { assetFetchImpl, calls, fail: (url) => failing.add(url) };
}

interface Harness {
  ctx: AppContext;
  data: DataLayer;
  storesDir: string;
  assets: ReturnType<typeof fakeAssetFetch>;
  request(method: string, path: string, body?: unknown): Promise<{
    status: number;
    payload: { ok: boolean; value?: unknown; error?: { code: string; message: string } };
  }>;
}

let harness: Harness;
let tempRoot: string;

/**
 * Puts a premium entitlement in the app's cache, the way a sign-in would.
 *
 * Entitlements are plain data now: nothing is signed, because everything this
 * gates runs on the user's machine. The enforceable gate lives in the service.
 */
function grantPremium(
  over: Partial<{ tier: "free" | "premium"; expiresAt: string; periodEnd: string | null }> = {},
): void {
  harness.data.settings.set(
    "account.entitlement",
    JSON.stringify({
      accountId: "acct_test",
      email: "buyer@example.com",
      tier: over.tier ?? "premium",
      status: "active",
      periodEnd: over.periodEnd === undefined ? "2027-01-01T00:00:00.000Z" : over.periodEnd,
      refreshAfter: "2026-09-05T12:00:00.000Z",
      expiresAt: over.expiresAt ?? "2026-09-18T12:00:00.000Z",
      issuedAt: "2026-09-04T12:00:00.000Z",
    }),
  );
  harness.data.settings.writeSecret("device_token", "dev_test_token");
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "dsv-api-"));
  const data = createDataLayer(":memory:", new Aes256GcmCipher(randomBytes(32)));
  const { fetchImpl } = fakeFetch();
  const assets = fakeAssetFetch();

  const ctx: AppContext = {
    data,
    storesDir: join(tempRoot, "stores"),
    databaseDir: tempRoot,
    fetchImpl,
    assetFetchImpl: assets.assetFetchImpl,
    now: () => new Date("2026-09-04T12:00:00.000Z"),
  };

  const app = createApp(ctx);

  harness = {
    ctx,
    data,
    assets,
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

  describe("AI providers", () => {
    it("validates and stores a Gemini key under its own name", async () => {
      const { status, payload } = await harness.request("PUT", "/api/settings/ai-key", {
        provider: "gemini",
        apiKey: "AIzaTestKey1234",
      });

      expect(status).toBe(200);
      expect((payload.value as { gemini: { present: boolean } }).gemini.present).toBe(
        true,
      );
      expect(harness.data.settings.readSecret("gemini_api_key")).toBe(
        "AIzaTestKey1234",
      );
      // Storing one provider's key must not disturb the other's.
      expect(harness.data.settings.readSecret("openrouter_api_key")).toBeNull();
    });

    it("never returns a Gemini key to the renderer", async () => {
      harness.data.settings.writeSecret("gemini_api_key", "AIzaSUPERSECRET9876");

      const { payload } = await harness.request("GET", "/api/settings");
      const serialised = JSON.stringify(payload);

      expect(serialised).not.toContain("AIzaSUPERSECRET9876");
      expect(serialised).toContain('"last4":"9876"');
    });

    it("defaults to OpenRouter", async () => {
      const { payload } = await harness.request("GET", "/api/settings");
      expect((payload.value as { ai: { provider: string } }).ai.provider).toBe(
        "openrouter",
      );
    });

    it("switches provider and remembers a model per provider", async () => {
      await harness.request("PUT", "/api/settings/ai", {
        provider: "gemini",
        model: "gemini-2.5-pro",
      });
      const { payload } = await harness.request("PUT", "/api/settings/ai", {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
      });

      const ai = (payload.value as { ai: { provider: string; models: Record<string, string> } })
        .ai;
      expect(ai.provider).toBe("openrouter");
      expect(ai.models).toEqual({
        gemini: "gemini-2.5-pro",
        openrouter: "anthropic/claude-sonnet-5",
      });
    });

    // Switching provider is a preference, not a key operation — it must never
    // delete or expose the key belonging to the provider being switched away
    // from.
    it("keeps both keys when the provider changes", async () => {
      harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-keep");
      harness.data.settings.writeSecret("gemini_api_key", "AIzaKeep");

      await harness.request("PUT", "/api/settings/ai", { provider: "gemini" });

      expect(harness.data.settings.readSecret("openrouter_api_key")).toBe(
        "sk-or-v1-keep",
      );
      expect(harness.data.settings.readSecret("gemini_api_key")).toBe("AIzaKeep");
    });

    it("rejects a provider it doesn't know", async () => {
      const { status } = await harness.request("PUT", "/api/settings/ai", {
        provider: "definitely-not-a-provider",
      });
      expect(status).toBe(400);
    });
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

describe("premium gating", () => {
  it("is free with no account", async () => {
    const { status } = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(status).toBe(402);
  });

  it("unlocks premium features once an entitlement is cached", async () => {
    grantPremium();

    const { status } = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(status).toBe(200);
  });

  it("locks again once the cached entitlement goes stale", async () => {
    grantPremium({ expiresAt: "2026-09-10T00:00:00.000Z" });
    harness.ctx.now = () => new Date("2026-10-01T00:00:00.000Z");

    const { status } = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(status).toBe(402);
  });

  it("ignores a cached entitlement that isn't shaped like one", async () => {
    // Freeing the gate from signatures means bad data must fail closed.
    harness.data.settings.set("account.entitlement", '{"tier":"premium"}');

    const { status } = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(status).toBe(402);
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

  const goPremium = async () => grantPremium();

  it("gives a free store a waitlist, not checkout", async () => {
    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: { storeName: "Sound Lab", checkout: { provider: "stripe" } },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string; paymentLinkUrl: null } } };
      warnings: { code: string }[];
    };

    expect(result.store.config.checkout.provider).toBe("waitlist");
    expect(result.store.config.checkout.paymentLinkUrl).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain("PREMIUM_REQUIRED");
  });

  it("keeps a free store on the waitlist even with a Stripe key saved", async () => {
    // The key is theirs; taking payment is the thing being sold.
    harness.data.settings.writeSecret("stripe_secret_key", "sk_test_abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: { storeName: "Sound Lab", checkout: { provider: "stripe" } },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string } } };
    };

    expect(result.store.config.checkout.provider).toBe("waitlist");
  });

  it("provisions Stripe payment links for a premium user with a key", async () => {
    await goPremium();
    harness.data.settings.writeSecret("stripe_secret_key", "sk_test_abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: {
        storeName: "Sound Lab",
        checkout: { provider: "stripe", mode: "payment_link" },
      },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string; paymentLinkUrl: string } } };
      warnings: unknown[];
    };

    expect(result.store.config.checkout.provider).toBe("stripe");
    expect(result.store.config.checkout.paymentLinkUrl).toBe(
      "https://buy.stripe.com/live_1",
    );
    expect(result.warnings).toEqual([]);
  });

  it("falls back to a waitlist for a premium user with no Stripe key", async () => {
    await goPremium();

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: {
        storeName: "Sound Lab",
        checkout: { provider: "stripe", mode: "payment_link" },
      },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string } } };
      warnings: { code: string }[];
    };

    expect(result.warnings.map((w) => w.code)).toContain("MISSING_STRIPE_KEY");
    expect(result.store.config.checkout.provider).toBe("waitlist");
  });

  it("gives a premium API-mode store an endpoint without calling Stripe", async () => {
    await goPremium();

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: {
        storeName: "Sound Lab",
        deployTarget: "vercel",
        checkout: { provider: "stripe", mode: "api" },
      },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string; mode: string } }; outputDir: string };
      warnings: unknown[];
    };

    // API mode needs no Stripe call from us: the store's own function creates
    // the session with the key in the user's hosting environment.
    expect(result.store.config.checkout.mode).toBe("api");
    expect(result.store.config.checkout.provider).toBe("stripe");
    expect(result.warnings).toEqual([]);
    expect(existsSync(join(result.store.outputDir, "src/pages/api/checkout.ts"))).toBe(
      true,
    );
  });

  it("falls back to payment links when a static host can't run an endpoint", async () => {
    await goPremium();
    harness.data.settings.writeSecret("stripe_secret_key", "sk_test_abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: {
        storeName: "Sound Lab",
        deployTarget: "static",
        checkout: { provider: "stripe", mode: "api" },
      },
    });
    const result = payload.value as {
      store: { config: { checkout: { mode: string } } };
      warnings: { message: string }[];
    };

    expect(result.store.config.checkout.mode).toBe("payment_link");
    expect(result.warnings.map((w) => w.message).join(" ")).toMatch(
      /static host can't run a checkout endpoint/i,
    );
  });

  it("still gives a free API-mode store a waitlist", async () => {
    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: {
        storeName: "Sound Lab",
        deployTarget: "vercel",
        checkout: { provider: "stripe", mode: "api" },
      },
    });
    const result = payload.value as {
      store: { config: { checkout: { provider: string } }; outputDir: string };
    };

    expect(result.store.config.checkout.provider).toBe("waitlist");
    expect(existsSync(join(result.store.outputDir, "src/pages/api/checkout.ts"))).toBe(
      false,
    );
  });

  it("does not upgrade a free store to checkout on regenerate", async () => {
    harness.data.settings.writeSecret("stripe_secret_key", "sk_test_abcd1234");
    const created = await harness.request("POST", "/api/stores", baseBody);
    const id = (created.payload.value as { store: { id: string } }).store.id;

    const again = await harness.request("POST", `/api/stores/${id}/regenerate`, {
      config: { storeName: "Sound Lab", checkout: { provider: "stripe" } },
    });
    const result = again.payload.value as {
      store: { config: { checkout: { provider: string } } };
    };

    expect(result.store.config.checkout.provider).toBe("waitlist");
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

  it("routes AI copy through Gemini when that is the chosen provider", async () => {
    harness.data.settings.writeSecret("gemini_api_key", "AIzaTestKey");
    await harness.request("PUT", "/api/settings/ai", { provider: "gemini" });

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiCopy: true,
    });
    const result = payload.value as {
      store: { outputDir: string };
      warnings: { code: string }[];
    };

    expect(result.warnings).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const data = JSON.parse(
      readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
    );
    expect(data.product.description).toBe("Gemini copy.");
  });

  // The provider preference decides which key is read. An OpenRouter key on
  // disk must not quietly satisfy a request configured for Gemini.
  it("warns about the selected provider's key, not whichever key exists", async () => {
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");
    await harness.request("PUT", "/api/settings/ai", { provider: "gemini" });

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiCopy: true,
    });
    const result = payload.value as { warnings: { code: string }[] };

    expect(result.warnings.map((w) => w.code)).toContain("MISSING_GEMINI_KEY");
  });

  it("generates image alt text when asked", async () => {
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

    const { payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiAltText: true,
    });
    const result = payload.value as { store: { outputDir: string } };

    const { readFileSync } = await import("node:fs");
    const data = JSON.parse(
      readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
    );
    // The stubbed model returns no `alt` array, so every image must still end
    // up with the title rather than an empty alt attribute.
    expect(data.product.images.length).toBeGreaterThan(0);
    for (const image of data.product.images) {
      expect(image.alt).toBeTruthy();
    }
  });

  it("still generates a store when the AI provider is down", async () => {
    harness.data.settings.writeSecret("gemini_api_key", "AIzaTestKey");
    // A model the provider doesn't have — the fake fetch 404s it, as Google does.
    await harness.request("PUT", "/api/settings/ai", {
      provider: "gemini",
      model: "no-such-model",
    });

    const { status, payload } = await harness.request("POST", "/api/stores", {
      ...baseBody,
      useAiCopy: true,
    });
    const result = payload.value as {
      store: { status: string; outputDir: string };
      warnings: { code: string }[];
    };

    // The store is the deliverable; AI is an optional garnish on top of it.
    expect(status).toBe(200);
    expect(result.store.status).toBe("generated");
    expect(existsSync(join(result.store.outputDir, "src/pages/index.astro"))).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("GEMINI_REQUEST_FAILED");
    expect(result.warnings[0]?.message).toMatch(/isn't available to your key/i);
  });

  describe("product assets", () => {
    it("downloads the images into the store instead of hotlinking AliExpress", async () => {
      const { payload } = await harness.request("POST", "/api/stores", baseBody);
      const result = payload.value as {
        store: { outputDir: string };
        warnings: { code: string }[];
      };

      expect(result.warnings).toEqual([]);
      expect(harness.assets.calls).toContain("https://ae01.alicdn.com/kf/a.jpg");
      expect(
        existsSync(join(result.store.outputDir, "public/images/product-01.jpg")),
      ).toBe(true);

      const { readFileSync } = await import("node:fs");
      const data = JSON.parse(
        readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
      );
      for (const image of data.product.images) {
        expect(image.url).toMatch(/^\/images\//);
        expect(image.url).not.toContain("alicdn.com");
      }
    });

    it("can be turned off, leaving the images remote", async () => {
      const { payload } = await harness.request("POST", "/api/stores", {
        ...baseBody,
        bundleAssets: false,
      });
      const result = payload.value as { store: { outputDir: string } };

      expect(harness.assets.calls).toEqual([]);
      const { readFileSync } = await import("node:fs");
      const data = JSON.parse(
        readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
      );
      expect(data.product.images[0].url).toContain("alicdn.com");
    });

    // One dead CDN image must not cost the user their store.
    it("warns and keeps the remote URL when an image won't download", async () => {
      harness.assets.fail("https://ae01.alicdn.com/kf/a.jpg");

      const { status, payload } = await harness.request("POST", "/api/stores", baseBody);
      const result = payload.value as {
        store: { status: string; outputDir: string };
        warnings: { code: string; message: string }[];
      };

      expect(status).toBe(200);
      expect(result.store.status).toBe("generated");
      expect(result.warnings.map((w) => w.code)).toContain("FETCH_FAILED");

      const { readFileSync } = await import("node:fs");
      const data = JSON.parse(
        readFileSync(join(result.store.outputDir, "src/data/store.json"), "utf8"),
      );
      expect(data.product.images[0].url).toContain("alicdn.com");
    });

    // The row must reflect what was generated, or a regenerate rebuilds from
    // the raw scrape and throws away rewritten copy and downloaded images.
    it("persists the bundled paths so a regenerate doesn't undo them", async () => {
      const created = await harness.request("POST", "/api/stores", baseBody);
      const id = (created.payload.value as { store: { id: string } }).store.id;

      const stored = harness.data.stores.findById(id);
      expect(stored?.product.images[0]?.url).toMatch(/^\/images\//);

      harness.assets.calls.length = 0;
      const again = await harness.request("POST", `/api/stores/${id}/regenerate`);
      const result = again.payload.value as {
        store: { product: { images: { url: string }[] } };
      };

      // Already local, so nothing is re-downloaded.
      expect(harness.assets.calls).toEqual([]);
      expect(result.store.product.images[0]?.url).toMatch(/^\/images\//);
    });

    it("keeps AI-rewritten copy across a regenerate", async () => {
      harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

      const created = await harness.request("POST", "/api/stores", {
        ...baseBody,
        useAiCopy: true,
      });
      const id = (created.payload.value as { store: { id: string } }).store.id;

      const again = await harness.request("POST", `/api/stores/${id}/regenerate`);
      const result = again.payload.value as {
        store: { product: { description: string } };
      };
      expect(result.store.product.description).toBe("Rewritten copy.");
    });
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

  it("runs a local backup for a premium user", async () => {
    await goPremiumWithBackupDir();

    const { status, payload } = await harness.request("POST", "/api/deploy/backup");
    const result = payload.value as { local: { bytes: number } | null };

    expect(status).toBe(200);
    expect(result.local?.bytes).toBeGreaterThan(0);
  });
});

/**
 * Cloud backup, exercised against the **real** hosted service.
 *
 * `cloudFetchImpl` is pointed at an in-process `createCloudApp`, so these run
 * the whole path: snapshot, encrypt on this side, authenticate with a signed
 * licence, store, list, download, decrypt. A mocked service would prove none of
 * the parts that actually matter.
 */
describe("cloud backup", () => {
  let cloudBlobs: MemoryBlobStore;
  let cloudCtx: CloudContext;

  /**
   * Makes the account premium on both sides.
   *
   * The app's cached entitlement is only how the *app* decides what to offer;
   * the service enforces premium itself against live account state, so the
   * account has to exist there too — which is the point of the split.
   */
  const goPremium = async () => {
    await applySubscriptionState(cloudCtx, {
      email: "buyer@example.com",
      stripeCustomerId: "cus_test",
      subscriptionId: "sub_test",
      status: "active",
      periodEnd: "2027-01-01T00:00:00.000Z",
    });

    const { code } = await issueSigninCode(cloudCtx, "buyer@example.com");
    const { deviceToken } = await redeemSigninCode(
      cloudCtx,
      "buyer@example.com",
      code,
    );

    grantPremium({ periodEnd: null });
    harness.data.settings.writeSecret("device_token", deviceToken);
  };

  beforeEach(() => {
    cloudBlobs = new MemoryBlobStore();

    cloudCtx = {
      config: {
        premiumPriceId: "price_test",
        siteUrl: "https://cloud.test",
        maxUploadBytes: 5 * 1024 * 1024,
        quotaBytes: 50 * 1024 * 1024,
        maxBackups: 3,
      },
      blobs: cloudBlobs,
      stripe: {} as never,
      mailer: { send: async () => {} },
      stripeWebhookSecret: "whsec_test",
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    };
    const cloud = createCloudApp(cloudCtx);

    harness.ctx.cloudBaseUrl = "https://cloud.test";
    harness.ctx.cloudFetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      cloud.fetch(new Request(input as string, init))) as typeof globalThis.fetch;
  });

  it("gates every cloud call behind premium", async () => {
    const list = await harness.request("GET", "/api/deploy/backup/cloud");
    expect(list.status).toBe(402);
  });

  it("uploads an encrypted snapshot and lists it back", async () => {
    await goPremium();
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: null,
      destination: "cloud",
    });

    const run = await harness.request("POST", "/api/deploy/backup");
    const result = run.payload.value as {
      local: unknown;
      cloud: { backup: { id: string; sizeBytes: number } } | null;
    };

    expect(run.status).toBe(200);
    expect(result.local).toBeNull();
    expect(result.cloud?.backup.sizeBytes).toBeGreaterThan(0);

    const list = await harness.request("GET", "/api/deploy/backup/cloud");
    expect((list.payload.value as { backups: unknown[] }).backups).toHaveLength(1);
  });

  // The entire justification for storing these on our infrastructure.
  it("stores nothing the service could read", async () => {
    await goPremium();
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-SUPERSECRET");
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: null,
      destination: "cloud",
    });

    await harness.request("POST", "/api/deploy/backup");

    // Account records share the store now, so scope this to backups: the
    // claim is that a *backup* reveals nothing, not that we hold no emails.
    const stored = await cloudBlobs.list("backups/");
    expect(stored).toHaveLength(1);

    const blob = await cloudBlobs.get(stored[0]!.key);
    const bytes = Buffer.from(blob!.bytes);
    // A SQLite file starts with this; the sealed blob must not.
    expect(bytes.subarray(0, 15).toString("latin1")).not.toContain("SQLite format");
    expect(bytes.toString("latin1")).not.toContain("SUPERSECRET");
    expect(bytes.toString("latin1")).not.toContain("sk-or-v1");
  });

  it("round-trips a backup through download and decryption", async () => {
    await goPremium();
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: null,
      destination: "cloud",
    });

    const run = await harness.request("POST", "/api/deploy/backup");
    const id = (run.payload.value as { cloud: { backup: { id: string } } }).cloud
      .backup.id;

    const restore = await harness.request(
      "POST",
      `/api/deploy/backup/cloud/${id}/restore`,
    );
    const result = restore.payload.value as { path: string; bytes: number };

    expect(restore.status).toBe(200);
    // Staged, not swapped in: the database is open and replacing it under a
    // running app is how you corrupt data while trying to rescue it.
    expect(result.path).toContain("pending-restore.sqlite");
    expect(readFileSync(result.path).subarray(0, 15).toString("latin1")).toContain(
      "SQLite format",
    );
  });

  it("refuses to restore with the wrong recovery key", async () => {
    await goPremium();
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: null,
      destination: "cloud",
    });

    const run = await harness.request("POST", "/api/deploy/backup");
    const id = (run.payload.value as { cloud: { backup: { id: string } } }).cloud
      .backup.id;

    // As if restoring on a different machine that never had the original key.
    harness.data.settings.deleteSecret("backup_encryption_key");

    const restore = await harness.request(
      "POST",
      `/api/deploy/backup/cloud/${id}/restore`,
    );
    expect(restore.status).toBe(500);
  });

  it("hands back a recovery key and takes one from another machine", async () => {
    await goPremium();

    const shown = await harness.request("GET", "/api/deploy/backup/recovery-key");
    const key = (shown.payload.value as { key: string }).key;
    expect(key).toMatch(/^[A-Z2-9-]+$/);

    const adopted = await harness.request("PUT", "/api/deploy/backup/recovery-key", {
      key,
    });
    expect(adopted.status).toBe(200);
  });

  it("rejects a mistyped recovery key rather than storing it", async () => {
    await goPremium();
    const { status, payload } = await harness.request(
      "PUT",
      "/api/deploy/backup/recovery-key",
      { key: "OOOO-OOOO-OOOO" },
    );

    expect(status).toBe(500);
    expect(JSON.stringify(payload)).toBeTruthy();
  });

  // One destination failing must not cancel the other.
  it("still writes locally when the upload fails", async () => {
    await goPremiumWithBackupDir();
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
      destination: "both",
    });

    harness.ctx.cloudFetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const { status, payload } = await harness.request("POST", "/api/deploy/backup");
    const result = payload.value as {
      local: { bytes: number } | null;
      failures: { destination: string }[];
    };

    expect(status).toBe(200);
    expect(result.local?.bytes).toBeGreaterThan(0);
    expect(result.failures.map((f) => f.destination)).toContain("cloud");
  });

  it("prunes to the service's retention limit", async () => {
    await goPremium();
    await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: null,
      destination: "cloud",
    });

    for (let i = 0; i < 5; i++) {
      await harness.request("POST", "/api/deploy/backup");
    }

    const list = await harness.request("GET", "/api/deploy/backup/cloud");
    expect((list.payload.value as { backups: unknown[] }).backups).toHaveLength(3);
  });
});

async function goPremiumWithBackupDir(): Promise<void> {
  grantPremium({ periodEnd: null });
  await harness.request("PUT", "/api/settings/backup", {
    enabled: true,
    directory: join(tempRoot, "backups"),
  });
}

/**
 * Accounts, from the app's side.
 *
 * The behaviour worth pinning: a renewal needs no action from the subscriber,
 * and the app keeps working offline while a cancellation still takes effect.
 */
describe("account", () => {
  const CLOUD = "https://cloud.test";

  /** The entitlement the hosted service would return. Plain data, unsigned. */
  const entitlement = (
    over: Partial<{
      tier: "free" | "premium";
      status: string;
      periodEnd: string | null;
      refreshAfter: string;
      expiresAt: string;
    }> = {},
  ) => ({
    accountId: "acct_test",
    email: "buyer@example.com",
    tier: over.tier ?? "premium",
    status: over.status ?? "active",
    periodEnd: over.periodEnd === undefined ? "2027-01-01T00:00:00.000Z" : over.periodEnd,
    refreshAfter: over.refreshAfter ?? "2026-09-05T12:00:00.000Z",
    expiresAt: over.expiresAt ?? "2026-09-18T12:00:00.000Z",
    issuedAt: "2026-09-04T12:00:00.000Z",
  });

  /** Stands in for the hosted service. */
  const cloud = (handlers: Record<string, () => { status?: number; body: unknown }>) => {
    const calls: string[] = [];
    harness.ctx.cloudBaseUrl = CLOUD;
    harness.ctx.fetchImpl = (async (url: string, init: Record<string, unknown> = {}) => {
      const path = String(url).replace(CLOUD, "");
      calls.push(`${String(init.method ?? "GET")} ${path}`);
      const handler = handlers[path];
      const result = handler ? handler() : { status: 404, body: { ok: false } };
      return {
        ok: (result.status ?? 200) < 400,
        status: result.status ?? 200,
        url: String(url),
        headers: { get: () => null, getSetCookie: () => [] as string[] },
        text: async () => JSON.stringify(result.body),
      };
    }) as never;
    return calls;
  };

  it("signs in with a mailed code and becomes premium", async () => {
    cloud({
      "/api/account/signin": () => ({ body: { ok: true, value: { message: "sent" } } }),
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_abc", entitlement: entitlement() } },
      }),
    });

    await harness.request("POST", "/api/account/signin", { email: "buyer@example.com" });
    const verified = await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    expect(verified.status).toBe(200);
    expect(verified.payload.value).toMatchObject({
      signedIn: true,
      tier: "premium",
      status: "active",
    });

    // And a premium-gated feature actually unlocks.
    const backup = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(backup.status).toBe(200);
  });

  it("never stores the device token where it can be read back", async () => {
    cloud({
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_secret_value", entitlement: entitlement() } },
      }),
    });
    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    const state = await harness.request("GET", "/api/account");
    expect(JSON.stringify(state.payload)).not.toContain("dev_secret_value");
  });

  it("refuses an entitlement that isn't shaped like one", async () => {
    // Nothing is signed any more, so malformed or partial data must fail closed
    // rather than being half-trusted.
    cloud({
      "/api/account/verify": () => ({
        body: {
          ok: true,
          value: { deviceToken: "dev_abc", entitlement: { tier: "premium" } },
        },
      }),
    });

    const verified = await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });
    expect(verified.status).toBe(500);

    const state = await harness.request("GET", "/api/account");
    expect((state.payload.value as { tier: string }).tier).toBe("free");
  });

  it("keeps working offline until the entitlement expires", async () => {
    cloud({
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_abc", entitlement: entitlement() } },
      }),
    });
    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    // The service is now unreachable.
    harness.ctx.fetchImpl = (async () => {
      throw new Error("offline");
    }) as never;

    // A refresh the user explicitly asked for reports that it couldn't reach
    // the service, rather than pretending it checked.
    const refreshed = await harness.request("POST", "/api/account/refresh");
    expect(refreshed.status).toBe(502);

    // But entitlement is unchanged: premium survives being offline, which is
    // the whole reason the entitlement is cached and signed.
    const state = await harness.request("GET", "/api/account");
    expect((state.payload.value as { tier: string }).tier).toBe("premium");
  });

  it("drops to free once a cached entitlement goes stale", async () => {
    cloud({
      "/api/account/verify": () => ({
        body: {
          ok: true,
          value: {
            deviceToken: "dev_abc",
            entitlement: entitlement({ expiresAt: "2026-09-10T00:00:00.000Z" }),
          },
        },
      }),
    });
    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    // Past the entitlement's expiry, with no way to refresh.
    harness.ctx.now = () => new Date("2026-10-01T00:00:00.000Z");
    harness.ctx.fetchImpl = (async () => {
      throw new Error("offline");
    }) as never;

    const state = await harness.request("GET", "/api/account");
    const value = state.payload.value as { tier: string; staleReason?: string };
    expect(value.tier).toBe("free");
    expect(value.staleReason).toMatch(/out of date/i);
  });

  it("follows a renewal without the user doing anything", async () => {
    let current = entitlement({ periodEnd: "2027-01-01T00:00:00.000Z" });
    cloud({
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_abc", entitlement: current } },
      }),
      "/api/account/entitlement": () => ({ body: { ok: true, value: { entitlement: current } } }),
    });

    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    // The subscription renews server-side. No new key, no paste.
    current = entitlement({ periodEnd: "2028-01-01T00:00:00.000Z" });
    const refreshed = await harness.request("POST", "/api/account/refresh");

    expect((refreshed.payload.value as { periodEnd: string }).periodEnd).toBe(
      "2028-01-01T00:00:00.000Z",
    );
    expect((refreshed.payload.value as { tier: string }).tier).toBe("premium");
  });

  it("signs out when the service says the device is gone", async () => {
    cloud({
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_abc", entitlement: entitlement() } },
      }),
      "/api/account/entitlement": () => ({
        status: 401,
        body: { ok: false, error: { message: "This device is signed out." } },
      }),
    });
    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    const refreshed = await harness.request("POST", "/api/account/refresh");
    expect(refreshed.status).toBe(401);

    const state = await harness.request("GET", "/api/account");
    expect((state.payload.value as { signedIn: boolean }).signedIn).toBe(false);
  });

  it("signs out locally even if the service can't be told", async () => {
    cloud({
      "/api/account/verify": () => ({
        body: { ok: true, value: { deviceToken: "dev_abc", entitlement: entitlement() } },
      }),
    });
    await harness.request("POST", "/api/account/verify", {
      email: "buyer@example.com",
      code: "123456",
    });

    harness.ctx.fetchImpl = (async () => {
      throw new Error("offline");
    }) as never;

    const out = await harness.request("POST", "/api/account/signout");
    expect((out.payload.value as { signedIn: boolean }).signedIn).toBe(false);
    expect((out.payload.value as { tier: string }).tier).toBe("free");
  });
});

/**
 * Applying AI copy to stores that already exist.
 *
 * Generation offers this per store at creation time only, so a user who added
 * a key afterwards — or switched provider — had no way to apply it to what
 * they already had.
 */
describe("bulk AI copy", () => {
  const baseBody = {
    url: "https://www.aliexpress.com/item/1005006.html",
    config: { storeName: "Copy Co" },
  };

  it("400s with the selected provider's code when no key is set", async () => {
    await harness.request("POST", "/api/stores", baseBody);

    const { status, payload } = await harness.request("POST", "/api/stores/ai-copy");

    // 400, not 500: the renderer routes the user to Settings on this code, and
    // a 500 would read as the app being broken.
    expect(status).toBe(400);
    expect(payload.error.code).toBe("MISSING_OPENROUTER_KEY");
  });

  it("names the selected provider, not whichever key happens to exist", async () => {
    await harness.request("POST", "/api/stores", baseBody);
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");
    await harness.request("PUT", "/api/settings/ai", { provider: "gemini" });

    const { status, payload } = await harness.request("POST", "/api/stores/ai-copy");

    expect(status).toBe(400);
    expect(payload.error.code).toBe("MISSING_GEMINI_KEY");
  });

  it("rewrites every store and rebuilds the generated site", async () => {
    const created = await harness.request("POST", "/api/stores", baseBody);
    const { store } = created.payload.value as { store: { outputDir: string } };
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

    const { status, payload } = await harness.request("POST", "/api/stores/ai-copy");
    const result = payload.value as {
      rewritten: number;
      failed: number;
      provider: string;
    };

    expect(status).toBe(200);
    expect(result).toMatchObject({ rewritten: 1, failed: 0, provider: "openrouter" });

    const data = JSON.parse(
      readFileSync(join(store.outputDir, "src/data/store.json"), "utf8"),
    );
    expect(data.product.description).toBe("Rewritten copy.");
  });

  it("only touches the stores it was given", async () => {
    const first = await harness.request("POST", "/api/stores", baseBody);
    await harness.request("POST", "/api/stores", {
      ...baseBody,
      config: { storeName: "Untouched Co" },
    });
    const { store } = first.payload.value as { store: { id: string } };
    harness.data.settings.writeSecret("openrouter_api_key", "sk-or-v1-abcd1234");

    const { payload } = await harness.request("POST", "/api/stores/ai-copy", {
      storeIds: [store.id],
    });

    expect(payload.value).toMatchObject({ rewritten: 1, failed: 0 });
  });
});
