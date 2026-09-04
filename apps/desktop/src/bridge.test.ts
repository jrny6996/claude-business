import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, call, desktop, type DesktopBridge } from "./bridge.js";

/** Installs a fake preload bridge on the global, as the renderer would see it. */
function install(bridge: Partial<DesktopBridge>): void {
  (globalThis as { window?: unknown }).window = { desktop: bridge };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("call", () => {
  it("unwraps a successful envelope", async () => {
    install({
      request: vi.fn().mockResolvedValue({
        status: 200,
        body: { ok: true, value: { status: "ok" } },
      }),
    });

    await expect(call("GET", "/api/health")).resolves.toEqual({ status: "ok" });
  });

  it("passes method, path and body through to the bridge", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, value: null },
    });
    install({ request });

    await call("PUT", "/api/settings/stripe-key", { secretKey: "sk_test" });

    expect(request).toHaveBeenCalledWith("PUT", "/api/settings/stripe-key", {
      secretKey: "sk_test",
    });
  });

  it("turns an error envelope into an ApiError carrying the API's message", async () => {
    install({
      request: vi.fn().mockResolvedValue({
        status: 400,
        body: {
          ok: false,
          error: {
            code: "UNSUPPORTED_SOURCE",
            message: "Only AliExpress product links are supported right now.",
            detail: "example.com",
          },
        },
      }),
    });

    try {
      await call("POST", "/api/stores/preview", { url: "https://example.com" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("UNSUPPORTED_SOURCE");
      expect((error as ApiError).message).toMatch(/only aliexpress/i);
      expect((error as ApiError).detail).toBe("example.com");
    }
  });

  it("handles an error envelope with no error object", async () => {
    install({
      request: vi.fn().mockResolvedValue({ status: 500, body: { ok: false } }),
    });

    await expect(call("GET", "/api/health")).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("handles an empty response body", async () => {
    install({
      request: vi.fn().mockResolvedValue({ status: 500, body: null }),
    });

    await expect(call("GET", "/api/health")).rejects.toThrowError(/empty response/i);
  });

  it("fails clearly when the preload bridge is missing", async () => {
    (globalThis as { window?: unknown }).window = {};

    await expect(call("GET", "/api/health")).rejects.toThrowError(
      /isn't fully loaded/i,
    );
  });
});

describe("api", () => {
  it("builds the deploy-instructions path with the provider query", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, value: {} },
    });
    install({ request });

    await api.deployInstructions("store-1", "netlify");

    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/deploy/store-1/instructions?provider=netlify",
      undefined,
    );
  });

  it("builds the secret-deletion path", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, value: {} },
    });
    install({ request });

    await api.deleteSecret("stripe_secret_key");

    expect(request).toHaveBeenCalledWith(
      "DELETE",
      "/api/settings/secrets/stripe_secret_key",
      undefined,
    );
  });

  it("omits the config wrapper when regenerating without changes", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, value: {} },
    });
    install({ request });

    await api.regenerateStore("store-1");

    expect(request).toHaveBeenCalledWith("POST", "/api/stores/store-1/regenerate", {});
  });
});

describe("desktop", () => {
  it("delegates shell actions to the bridge", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    install({ openExternal });

    await expect(desktop.openExternal("https://stripe.com")).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://stripe.com");
  });
});
