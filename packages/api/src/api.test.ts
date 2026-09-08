import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aes256GcmCipher, createDataLayer, type DataLayer } from "@repo/db";
import { generateLicenseKeyPair, signLicensePayload } from "./services/license-keys.js";
import type { BinaryFetchLike, FetchLike } from "@repo/store-generator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createApp } from "./index.js";
import { MemoryBlobStore, createCloudApp } from "@repo/cloud";

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
 * A throwaway issuer keypair. Signing real licences in tests is the only way to
 * exercise the path users actually take — the API deliberately has no way to
 * grant a tier without a valid signature.
 */
const issuer = generateLicenseKeyPair();

function licenseKey(
  over: Partial<{ tier: "free" | "premium"; expiresAt: string | null }> = {},
): string {
  return signLicensePayload(
    {
      v: 1,
      email: "buyer@example.com",
      tier: over.tier ?? "premium",
      expiresAt: over.expiresAt === undefined ? "2027-01-01T00:00:00.000Z" : over.expiresAt,
      issuedAt: "2026-09-04T00:00:00.000Z",
      id: "lic_test_1",
    },
    issuer.privateKeyPem,
  );
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
    licensePublicKeyPem: issuer.publicKeyPem,
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
        model: "gemini-3-pro",
      });
      const { payload } = await harness.request("PUT", "/api/settings/ai", {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
      });

      const ai = (payload.value as { ai: { provider: string; models: Record<string, string> } })
        .ai;
      expect(ai.provider).toBe("openrouter");
      expect(ai.models).toEqual({
        gemini: "gemini-3-pro",
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

describe("licensing", () => {
  it("starts on the free tier with no licence", async () => {
    const { payload } = await harness.request("GET", "/api/license");
    const value = payload.value as { tier: string; license: unknown };
    expect(value.tier).toBe("free");
    expect(value.license).toBeNull();
  });

  it("activates a genuine licence and unlocks premium features", async () => {
    const activated = await harness.request("POST", "/api/license/activate", {
      key: licenseKey(),
    });
    expect(activated.status).toBe(200);
    expect((activated.payload.value as { tier: string }).tier).toBe("premium");

    const backup = await harness.request("PUT", "/api/settings/backup", {
      enabled: true,
      directory: join(tempRoot, "backups"),
    });
    expect(backup.status).toBe(200);
  });

  it("refuses a forged licence", async () => {
    const forged = generateLicenseKeyPair();
    const key = signLicensePayload(
      {
        v: 1,
        email: "attacker@example.com",
        tier: "premium",
        expiresAt: null,
        issuedAt: "2026-09-04T00:00:00.000Z",
        id: "lic_forged",
      },
      forged.privateKeyPem,
    );

    const { status, payload } = await harness.request(
      "POST",
      "/api/license/activate",
      { key },
    );
    expect(status).toBe(400);
    expect(payload.error?.message).toMatch(/isn't genuine/i);
  });

  it("refuses a tampered licence", async () => {
    const key = licenseKey();
    const tampered = `${key.slice(0, -6)}AAAAAA`;

    const { status } = await harness.request("POST", "/api/license/activate", {
      key: tampered,
    });
    expect(status).toBe(400);
  });

  it("refuses a licence that expired", async () => {
    const { status, payload } = await harness.request(
      "POST",
      "/api/license/activate",
      { key: licenseKey({ expiresAt: "2020-01-01T00:00:00.000Z" }) },
    );
    expect(status).toBe(400);
    expect(payload.error?.message).toMatch(/expired/i);
  });

  it("refuses junk", async () => {
    const { status, payload } = await harness.request(
      "POST",
      "/api/license/activate",
      { key: "definitely-not-a-licence" },
    );
    expect(status).toBe(400);
    expect(payload.error?.message).toMatch(/doesn't look like a licence key/i);
  });

  it("downgrades on its own once a licence lapses", async () => {
    // Activated while valid, then read back after the expiry passes: the stored
    // key is re-verified on every read rather than trusted from the database.
    await harness.request("POST", "/api/license/activate", {
      key: licenseKey({ expiresAt: "2026-09-05T00:00:00.000Z" }),
    });
    expect(
      ((await harness.request("GET", "/api/license")).payload.value as {
        tier: string;
      }).tier,
    ).toBe("premium");

    harness.ctx.now = () => new Date("2026-10-01T00:00:00.000Z");

    const later = (await harness.request("GET", "/api/license")).payload.value as {
      tier: string;
      license: { valid: boolean };
    };
    expect(later.tier).toBe("free");
    expect(later.license.valid).toBe(false);
  });

  it("never returns the licence key itself, only a hint", async () => {
    const key = licenseKey();
    await harness.request("POST", "/api/license/activate", { key });

    const { payload } = await harness.request("GET", "/api/license");
    expect(JSON.stringify(payload)).not.toContain(key);
    expect((payload.value as { license: { hint: string } }).license.hint).toContain(
      "\u2026",
    );
  });

  it("deactivates back to free", async () => {
    await harness.request("POST", "/api/license/activate", { key: licenseKey() });
    const { payload } = await harness.request("DELETE", "/api/license");
    expect((payload.value as { tier: string }).tier).toBe("free");
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

  const goPremium = () =>
    harness.request("POST", "/api/license/activate", { key: licenseKey() });

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

  const goPremium = () =>
    harness.request("POST", "/api/license/activate", {
      key: licenseKey({ expiresAt: null }),
    });

  beforeEach(() => {
    cloudBlobs = new MemoryBlobStore();

    const cloud = createCloudApp({
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
      // The service verifies the licences this test harness signs.
      licensePrivateKeyPem: issuer.privateKeyPem,
      licensePublicKeyPem: issuer.publicKeyPem,
      stripeWebhookSecret: "whsec_test",
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    });

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

    const stored = await cloudBlobs.list("");
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
  await harness.request("POST", "/api/license/activate", {
    key: licenseKey({ expiresAt: null }),
  });
  await harness.request("PUT", "/api/settings/backup", {
    enabled: true,
    directory: join(tempRoot, "backups"),
  });
}
