import { AppError } from "@repo/shared";
import { describe, expect, it } from "vitest";
import { detectChallenge, detectChallengeInHtml } from "./challenge.js";
import { fetchPage, type FetchLike } from "./fetch.js";
import { httpPageSource } from "./page-source.js";

interface Hop {
  status: number;
  location?: string;
  setCookie?: string[];
  body?: string;
}

/**
 * Scripted server. Each entry is one HTTP response; `fetchPage` follows the
 * redirects itself, so this also records the Cookie header it was sent on every
 * hop — which is the whole point of the jar.
 */
function scriptedFetch(hops: Hop[]) {
  const requests: { url: string; cookie: string }[] = [];
  let index = 0;

  const fetchImpl = (async (url: string, init: Record<string, unknown> = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    requests.push({ url, cookie: headers.Cookie ?? "" });

    const hop = hops[Math.min(index++, hops.length - 1)]!;
    return {
      ok: hop.status >= 200 && hop.status < 300,
      status: hop.status,
      url,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? (hop.location ?? null) : null,
        getSetCookie: () => hop.setCookie ?? [],
      },
      text: async () => hop.body ?? "",
    };
  }) as unknown as FetchLike;

  return { fetchImpl, requests };
}

const noSleep = async () => {};

describe("fetchPage redirects", () => {
  it("follows a redirect chain to the final page", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 302, location: "https://www.aliexpress.us/item/2.html" },
      { status: 200, body: "<html>done</html>" },
    ]);

    const page = await fetchPage("https://www.aliexpress.com/item/1.html", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(page.html).toBe("<html>done</html>");
    expect(page.finalUrl).toBe("https://www.aliexpress.us/item/2.html");
  });

  it("carries cookies set mid-chain onto later hops", async () => {
    // This is the bug that made real scrapes fail: AliExpress redirects through
    // a sync_cookie_read/write pair, and a client that drops the cookie it just
    // received bounces between them until it runs out of redirects.
    const { fetchImpl, requests } = scriptedFetch([
      {
        status: 302,
        location: "https://login.aliexpress.com/sync_cookie_write.htm",
        setCookie: ["xman_us_f=x_locale%3Den_US; Path=/", "JSESSIONID=abc; Path=/"],
      },
      { status: 200, body: "<html>ok</html>" },
    ]);

    await fetchPage("https://www.aliexpress.com/item/1.html", {
      fetchImpl,
      sleep: noSleep,
    });

    expect(requests[1]?.cookie).toContain("JSESSIONID=abc");
    expect(requests[1]?.cookie).toContain("xman_us_f=");
  });

  it("sends region-pinning cookies on the very first request", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: "ok" }]);

    await fetchPage("https://www.aliexpress.com/item/1.html", {
      fetchImpl,
      sleep: noSleep,
    });

    expect(requests[0]?.cookie).toContain("aep_usuc_f=");
    expect(requests[0]?.cookie).toContain("intl_locale=en_US");
  });

  it("reports a redirect loop as such, not as a connection problem", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 302, location: "https://www.aliexpress.com/loop" },
    ]);

    try {
      await fetchPage("https://www.aliexpress.com/item/1.html", {
        fetchImpl,
        retries: 0,
        maxRedirects: 3,
        sleep: noSleep,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).detail).toBe("redirect loop");
      expect((error as AppError).message).not.toMatch(/connection/i);
    }
  });
});

describe("fetchPage failures", () => {
  it("maps 404 to a dead listing", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 404 }]);
    await expect(
      fetchPage("https://www.aliexpress.com/item/1.html", {
        fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toThrowError(/no longer exists/i);
  });

  it("maps 403 to rate limiting rather than a network fault", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 403 }]);
    await expect(
      fetchPage("https://www.aliexpress.com/item/1.html", {
        fetchImpl,
        retries: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrowError(/rate-limiting/i);
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      const ok = calls > 1;
      return {
        ok,
        status: ok ? 200 : 500,
        url,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => "<html>recovered</html>",
      };
    }) as unknown as FetchLike;

    const page = await fetchPage("https://www.aliexpress.com/item/1.html", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(page.html).toBe("<html>recovered</html>");
    expect(calls).toBe(2);
  });

  it("surfaces a thrown network error with connection wording", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    await expect(
      fetchPage("https://www.aliexpress.com/item/1.html", {
        fetchImpl,
        retries: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrowError(/check your connection/i);
  });
});

describe("detectChallenge", () => {
  it("recognises the anti-bot interstitial", () => {
    expect(
      detectChallenge(
        "https://www.aliexpress.com//item/1.html/_____tmd_____/punish?x5secdata=abc",
      ),
    ).toBe("bot");
  });

  it("recognises the cookie-sync handshake", () => {
    expect(
      detectChallenge("https://login.aliexpress.com/sync_cookie_read.htm?x=1"),
    ).toBe("cookie-sync");
  });

  it("recognises a login wall", () => {
    expect(detectChallenge("https://login.aliexpress.com/?return=x")).toBe("login");
  });

  it("passes a normal product URL", () => {
    expect(detectChallenge("https://www.aliexpress.us/item/2.html")).toBeNull();
  });

  it("finds a challenge injected into the body", () => {
    expect(detectChallenge("https://www.aliexpress.com/item/1.html")).toBeNull();
    expect(detectChallengeInHtml("<html>Slide to verify</html>")).toBe("bot");
    expect(detectChallengeInHtml("<html>a product</html>")).toBeNull();
  });
});

describe("httpPageSource", () => {
  it("refuses a page that is really a bot wall", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: "<html>x5secdata blocked</html>" },
    ]);

    await expect(
      httpPageSource({ fetchImpl, sleep: noSleep }).load(
        "https://www.aliexpress.com/item/1.html",
      ),
    ).rejects.toMatchObject({ code: "BOT_CHALLENGE" });
  });

  it("returns a genuine page unchanged", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: "<html>a real product</html>" },
    ]);

    const page = await httpPageSource({ fetchImpl, sleep: noSleep }).load(
      "https://www.aliexpress.com/item/1.html",
    );
    expect(page.html).toContain("a real product");
  });
});
