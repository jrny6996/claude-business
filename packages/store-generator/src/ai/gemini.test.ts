import { AppError, type NormalizedProduct } from "@repo/shared";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../scrape/fetch.js";
import { createAiClient } from "./client.js";
import { rewriteProductCopy } from "./copy.js";
import { GeminiClient } from "./gemini.js";

const product: NormalizedProduct = {
  sourceId: "1",
  sourceUrl: "https://www.aliexpress.com/item/1.html",
  title: "Earbuds",
  description: "Original scraped description.",
  highlights: ["original bullet"],
  price: { amountCents: 1000, currency: "USD" },
  compareAtPrice: null,
  images: [],
  variants: [],
  ratingAverage: null,
  ratingCount: null,
  shipsFrom: null,
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

/** Records every call so we can assert on what actually went over the wire. */
function recorder(
  respond: (call: number) => { ok?: boolean; status?: number; body: string },
) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    const reply = respond(calls.length);
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      url,
      text: async () => reply.body,
    };
  }) as unknown as FetchLike;
  return { calls, fetchImpl };
}

const textReply = (text: string) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

describe("GeminiClient", () => {
  it("refuses to construct without a key, prompting the user to add one", () => {
    try {
      new GeminiClient({ apiKey: "   " });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("MISSING_GEMINI_KEY");
      expect((error as AppError).message).toMatch(/gemini api key/i);
    }
  });

  it("sends the key as a header, never in the query string", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: textReply("hi") }));

    await new GeminiClient({ apiKey: "AIzaSECRET", fetchImpl }).complete(
      "system",
      "user",
    );

    const [call] = calls;
    expect(call?.url).not.toContain("AIzaSECRET");
    expect(call?.url).not.toContain("key=");
    expect(
      (call?.init.headers as Record<string, string>)["x-goog-api-key"],
    ).toBe("AIzaSECRET");
  });

  it("puts the system prompt in system_instruction, not a message role", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: textReply("hi") }));

    await new GeminiClient({ apiKey: "AIza", fetchImpl }).complete(
      "be terse",
      "the product",
    );

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      system_instruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(body.system_instruction.parts[0]?.text).toBe("be terse");
    expect(body.contents[0]).toMatchObject({ role: "user" });
    expect(body.contents[0]?.parts[0]?.text).toBe("the product");
  });

  it("uses the requested model in the path", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: textReply("hi") }));

    await new GeminiClient({
      apiKey: "AIza",
      model: "gemini-3-pro",
      fetchImpl,
    }).complete("s", "u");

    expect(calls[0]?.url).toContain("/models/gemini-3-pro:generateContent");
  });

  // Google reports a bad key as a 400 as often as a 401, so the body matters.
  it("reads API_KEY_INVALID out of a 400 as a key problem", async () => {
    const { fetchImpl } = recorder(() => ({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: { status: "API_KEY_INVALID" } }),
    }));

    await expect(
      new GeminiClient({ apiKey: "AIzabad", fetchImpl }).validateKey(),
    ).rejects.toMatchObject({ code: "MISSING_GEMINI_KEY" });
  });

  it("treats a 401 as a key problem too", async () => {
    const { fetchImpl } = recorder(() => ({ ok: false, status: 401, body: "{}" }));

    await expect(
      new GeminiClient({ apiKey: "AIza", fetchImpl }).validateKey(),
    ).rejects.toMatchObject({ code: "MISSING_GEMINI_KEY" });
  });

  it("reports quota exhaustion distinctly from a broken key", async () => {
    const { fetchImpl } = recorder(() => ({ ok: false, status: 429, body: "{}" }));

    await expect(
      new GeminiClient({ apiKey: "AIza", fetchImpl }).complete("s", "u"),
    ).rejects.toMatchObject({
      code: "GEMINI_REQUEST_FAILED",
      message: expect.stringMatching(/rate limit or quota/i),
    });
  });

  it("does not leak the key in errors", async () => {
    const { fetchImpl } = recorder(() => ({
      ok: false,
      status: 500,
      body: "boom",
    }));

    try {
      await new GeminiClient({ apiKey: "AIzaSUPERSECRET", fetchImpl }).complete(
        "s",
        "u",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("SUPERSECRET");
      expect((error as AppError).message).not.toContain("SUPERSECRET");
    }
  });

  // A safety block is an HTTP 200 with no candidate; without this check it
  // would surface as "the model returned an empty response".
  it("explains a safety block rather than calling it an empty response", async () => {
    const { fetchImpl } = recorder(() => ({
      body: JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
    }));

    await expect(
      new GeminiClient({ apiKey: "AIza", fetchImpl }).complete("s", "u"),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/declined to rewrite/i),
    });
  });

  it("joins multi-part responses", async () => {
    const { fetchImpl } = recorder(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "one " }, { text: "two" }] } }],
      }),
    }));

    await expect(
      new GeminiClient({ apiKey: "AIza", fetchImpl }).complete("s", "u"),
    ).resolves.toBe("one two");
  });
});

describe("createAiClient", () => {
  it("builds a Gemini client when asked for one", async () => {
    const client = await createAiClient({ provider: "gemini", apiKey: "AIza" });
    expect(client.provider).toBe("gemini");
    expect(client.model).toBe("gemini-3-flash");
  });

  it("defaults to OpenRouter, which is what callers used before", async () => {
    const client = await createAiClient({ apiKey: "sk-or-v1" });
    expect(client.provider).toBe("openrouter");
  });

  it("propagates the provider's own missing-key error", async () => {
    await expect(
      createAiClient({ provider: "gemini", apiKey: "" }),
    ).rejects.toMatchObject({ code: "MISSING_GEMINI_KEY" });
  });
});

describe("rewriteProductCopy over Gemini", () => {
  it("produces the same shape as it does over OpenRouter", async () => {
    const { fetchImpl } = recorder(() => ({
      body: textReply(
        '```json\n{"description":"Rewritten.","highlights":["a","b"]}\n```',
      ),
    }));

    await expect(
      rewriteProductCopy(product, { provider: "gemini", apiKey: "AIza", fetchImpl }),
    ).resolves.toEqual({ description: "Rewritten.", highlights: ["a", "b"] });
  });

  it("falls back to the scraped copy when the model returns nonsense", async () => {
    const { fetchImpl } = recorder(() => ({ body: textReply("no json here") }));

    await expect(
      rewriteProductCopy(product, { provider: "gemini", apiKey: "AIza", fetchImpl }),
    ).resolves.toEqual({
      description: "Original scraped description.",
      highlights: ["original bullet"],
    });
  });
});
