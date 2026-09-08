import { AppError, type NormalizedProduct } from "@repo/shared";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../scrape/fetch.js";
import { parseCopyResponse, rewriteProductCopy } from "./copy.js";
import { OpenRouterClient } from "./openrouter.js";

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

const replyWith = (content: string): FetchLike =>
  (async (url: string) => ({
    ok: true,
    status: 200,
    url,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content } }] }),
  })) as unknown as FetchLike;

describe("OpenRouterClient", () => {
  it("refuses to construct without a key, prompting the user to add one", () => {
    try {
      new OpenRouterClient({ apiKey: "  " });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("MISSING_OPENROUTER_KEY");
      expect((error as AppError).message).toMatch(/add your openrouter api key/i);
    }
  });

  it("treats a 401 as a key problem", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      url: "",
      text: async () => "{}",
    })) as unknown as FetchLike;

    await expect(
      new OpenRouterClient({ apiKey: "sk-or-bad", fetchImpl }).validateKey(),
    ).rejects.toMatchObject({ code: "MISSING_OPENROUTER_KEY" });
  });

  it("reports an out-of-credit account distinctly", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 402,
      url: "",
      text: async () => "{}",
    })) as unknown as FetchLike;

    await expect(
      new OpenRouterClient({ apiKey: "sk-or-v1", fetchImpl }).validateKey(),
    ).rejects.toMatchObject({ message: expect.stringMatching(/out of credit/i) });
  });

  it("does not leak the key in errors", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 500,
      url: "",
      text: async () => "boom",
    })) as unknown as FetchLike;

    try {
      await new OpenRouterClient({
        apiKey: "sk-or-v1-SUPERSECRET",
        fetchImpl,
      }).validateKey();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(JSON.stringify((error as AppError).toShape())).not.toContain(
        "SUPERSECRET",
      );
    }
  });

  it("rejects an empty completion", async () => {
    await expect(
      new OpenRouterClient({
        apiKey: "sk-or-v1",
        fetchImpl: replyWith("   "),
      }).complete("s", "u"),
    ).rejects.toMatchObject({ code: "OPENROUTER_REQUEST_FAILED" });
  });
});

describe("parseCopyResponse", () => {
  it("parses clean JSON", () => {
    expect(
      parseCopyResponse('{"description":"New copy","highlights":["a","b"]}', product),
    ).toEqual({ description: "New copy", highlights: ["a", "b"] });
  });

  it("parses JSON inside a code fence", () => {
    const raw = '```json\n{"description":"Fenced","highlights":[]}\n```';
    expect(parseCopyResponse(raw, product).description).toBe("Fenced");
  });

  it("parses JSON surrounded by prose", () => {
    const raw = 'Sure! {"description":"Prosed","highlights":["x"]} Hope that helps.';
    expect(parseCopyResponse(raw, product).description).toBe("Prosed");
  });

  it("caps highlights at five", () => {
    const raw = JSON.stringify({
      description: "d",
      highlights: ["1", "2", "3", "4", "5", "6", "7"],
    });
    expect(parseCopyResponse(raw, product).highlights).toHaveLength(5);
  });

  it("drops non-string highlights", () => {
    const raw = '{"description":"d","highlights":["ok",1,null]}';
    expect(parseCopyResponse(raw, product).highlights).toEqual(["ok"]);
  });

  it("falls back to the scraped copy on unparseable output", () => {
    expect(parseCopyResponse("total nonsense", product)).toEqual({
      description: "Original scraped description.",
      highlights: ["original bullet"],
    });
  });

  it("falls back when the model returned an empty description", () => {
    expect(parseCopyResponse('{"description":"  "}', product).description).toBe(
      "Original scraped description.",
    );
  });
});

describe("rewriteProductCopy", () => {
  it("returns rewritten copy", async () => {
    const result = await rewriteProductCopy(product, {
      apiKey: "sk-or-v1",
      fetchImpl: replyWith('{"description":"Rewritten.","highlights":["fast"]}'),
    });
    expect(result).toEqual({ description: "Rewritten.", highlights: ["fast"] });
  });
});
