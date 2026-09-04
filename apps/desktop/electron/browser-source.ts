import { AppError } from "@repo/shared";
import {
  detectChallenge,
  type ChallengeKind,
  type DomProduct,
  type LoadedPage,
  type PageSource,
} from "@repo/store-generator";
import { BrowserWindow } from "electron";

/**
 * Loads product pages in a real Chromium window.
 *
 * Why this exists: AliExpress renders product data client-side. The HTML it
 * serves has an empty `<title>`, empty OpenGraph tags and no price anywhere —
 * there is nothing for an HTTP scraper to read. On top of that it puts an
 * anti-bot interstitial (`/_____tmd_____/punish`) in front of non-browser
 * clients.
 *
 * So we render the page properly and read the same `window.runParams` object
 * the real storefront uses.
 *
 * We do not attempt to defeat the interstitial. When one appears the window is
 * shown to the user, who clears it themselves in their own session, on their
 * own machine and IP. Cookies persist in a dedicated partition so a check
 * cleared once keeps working for later scrapes.
 */
export interface BrowserSourceEvents {
  /** A human needs to act. The window has been shown. */
  onChallenge(info: { url: string; kind: ChallengeKind }): void;
  /** The page loaded and the window has been hidden again. */
  onResolved(): void;
}

export interface BrowserSourceOptions {
  events?: Partial<BrowserSourceEvents>;
  /** How long to wait for a clean page before deciding something is wrong. */
  quietTimeoutMs?: number;
  /** How long to leave the window open for the user to clear a check. */
  challengeTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Electron's default UA advertises `Electron/<version>`, which some sites
 * reject outright. This is a real Chromium rendering a real page, so it
 * identifies as Chrome; nothing else about the browser is disguised.
 */
/** Reloads of the listing after a cleared check, before we give up. */
const MAX_RENAVIGATIONS = 3;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Runs in the page. Returns the data we need, or nulls if it isn't ready.
 *
 * The full DOM is only serialised once the product is actually there: this is
 * polled every few hundred milliseconds for up to several minutes while a user
 * clears a check, and an AliExpress page is ~75KB. Sending that across the IPC
 * boundary on every tick is pure waste, so the not-ready case returns a single
 * boolean instead.
 */
const PROBE = `(() => {
  const pick = (o, ...p) => p.reduce((a, k) => (a == null ? a : a[k]), o);
  const text = (...sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const value = el && el.textContent ? el.textContent.trim() : "";
      if (value) return value;
    }
    return null;
  };

  // AliExpress exposes page state under more than one global depending on the
  // rollout, so try each and take whichever actually has a product in it.
  const candidates = [window.runParams, window._pdp_cache_, window._d_c_];
  let raw = null;
  let subject = null;
  for (const candidate of candidates) {
    const data = candidate && (candidate.data || candidate);
    const found =
      pick(data, "titleComponent", "subject") ||
      pick(data, "productInfoComponent", "subject");
    if (found) { raw = data; subject = found; break; }
  }

  // The rendered DOM is the source that is true whenever a human can see the
  // product. Class names are content-hashed (price-default--current--F8OlYIo),
  // so match on the stable middle segment, not a guessed prefix.
  const domTitle = (() => {
    const t = text('[data-pl="product-title"]', 'h1[class*="title--"]');
    if (t && t.length > 8 && !/^aliexpress$/i.test(t)) return t;
    return null;
  })();

  const priceText = text(
    '[class*="price-default--current"]',
    '[class*="--currentPrice--"]',
    '[class*="product-price-value"]',
    '[data-pl="product-price"]'
  );

  const skuVariants = [];
  for (const group of document.querySelectorAll('[class*="sku-item--property"]')) {
    const label = group.querySelector('[class*="sku-item--title"]');
    const name = label && label.textContent
      ? label.textContent.replace(/[:：].*$/, "").trim()
      : null;
    if (!name) continue;

    for (const cell of group.querySelectorAll("[data-sku-col]")) {
      const id = cell.getAttribute("data-sku-col");
      if (!id) continue;
      const img = cell.querySelector("img");
      const value =
        (img && img.getAttribute("alt")) ||
        (cell.textContent ? cell.textContent.trim() : "");
      if (!value) continue;
      const cls = cell.getAttribute("class") || "";
      skuVariants.push({
        id,
        options: { [name]: value },
        available: !/soldOut/i.test(cls),
      });
    }
  }

  const domProduct = {
    title: domTitle,
    priceText,
    compareAtText: text('[class*="price-default--original"]', '[class*="--originalPrice--"]'),
    ratingText: text('[class*="reviewer--rating"]'),
    ratingCountText: text('[class*="reviewer--reviews"]'),
    shipsFrom: text('[class*="dynamic-shipping-titleLayout"]', '[class*="dynamic-shipping-line"]'),
    highlights: [...document.querySelectorAll('[class*="seo-sellpoints--sellerPoint"] li')]
      .map((li) => (li.textContent || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 6),
    variants: skuVariants.slice(0, 40),
    images: [...document.querySelectorAll('[class*="slider--img"] img, [class*="image-view"] img')]
      .map((img) => img.getAttribute("src") || "")
      .filter(Boolean)
      .slice(0, 12),
  };

  const ready = Boolean(subject || (domTitle && priceText));

  if (!ready) {
    // domProduct is still reported (without the DOM) purely so a timeout can
    // say which fields were missing. It is never used as a result: readiness is
    // gated on \`subject\`.
    return {
      url: location.href,
      subject: null,
      pageData: null,
      domProduct: domProduct,
      html: "",
      challengeInBody: /x5secdata|_____tmd_____|Slide to verify|nc_wrapper/i.test(
        document.body ? document.body.innerHTML.slice(0, 20000) : ""
      ),
    };
  }

  let pageData = null;
  try {
    // Page state can hold non-serializable values; a JSON round-trip inside the
    // page keeps only what survives the IPC boundary anyway.
    if (raw) pageData = JSON.parse(JSON.stringify(raw));
  } catch {
    pageData = null;
  }

  return {
    url: location.href,
    subject: subject || domTitle,
    pageData,
    domProduct,
    html: document.documentElement.outerHTML,
    challengeInBody: false,
  };
})()`;

interface ProbeResult {
  url: string;
  subject: string | null;
  pageData: unknown;
  domProduct: DomProduct | null;
  html: string;
  challengeInBody: boolean;
}

export interface BrowserPageSource extends PageSource {
  dispose(): void;
}

export function createBrowserPageSource({
  events = {},
  quietTimeoutMs = 15_000,
  challengeTimeoutMs = 240_000,
  pollIntervalMs = 600,
}: BrowserSourceOptions = {}): BrowserPageSource {
  let win: BrowserWindow | undefined;
  // Serialised: two concurrent scrapes would fight over one window.
  let queue: Promise<unknown> = Promise.resolve();

  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;

    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      title: "AliExpress",
      webPreferences: {
        // A dedicated persistent partition: the user's AliExpress session
        // (including a cleared bot check) survives restarts, and is kept apart
        // from anything else the app does.
        partition: "persist:aliexpress",
        // The window spends most of its life hidden. Chromium reports it as
        // visible either way, but this keeps its timers running at full rate
        // so a client-rendered page hydrates as promptly as a foreground one.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setMenuBarVisibility(false);
    win.webContents.setUserAgent(USER_AGENT);
    win.on("closed", () => {
      win = undefined;
    });

    return win;
  };

  const load = async (url: string): Promise<LoadedPage> => {
    const target = ensureWindow();
    // Whether the window is on screen, and whether we are currently waiting on
    // a person — separate, because after a check is cleared the window stays
    // visible while we go back to loading the listing on a normal budget.
    let windowVisible = false;
    let awaitingHuman = false;
    // Sticky: the interstitial navigates as the user works through it, so by
    // the time we give up neither the URL nor the body still looks like a
    // challenge. Without remembering it, a failed check gets misreported as
    // "this listing has no product on it".
    let seenChallenge: ChallengeKind | null = null;
    let renavigations = 0;
    // Kept so a timeout can say what it actually saw. "No product data" with no
    // further detail leaves nobody any way to tell a soft block from a layout
    // change from a dead listing.
    let lastProbe: ProbeResult | undefined;

    try {
      // A challenge redirect makes loadURL reject; the polling below is what
      // actually decides success, so a rejection here is not yet fatal.
      await target.loadURL(url).catch(() => undefined);

      const deadline = () => (awaitingHuman ? challengeTimeoutMs : quietTimeoutMs);
      let started = Date.now();

      for (;;) {
        if (target.isDestroyed()) {
          throw new AppError(
            "CHALLENGE_ABANDONED",
            "The AliExpress window was closed before the listing loaded.",
          );
        }

        await delay(pollIntervalMs);

        let probe: ProbeResult;
        try {
          probe = (await target.webContents.executeJavaScript(
            PROBE,
          )) as ProbeResult;
        } catch {
          // Mid-navigation; try again on the next tick.
          continue;
        }
        lastProbe = probe;

        if (probe.subject) {
          if (windowVisible && !target.isDestroyed()) {
            target.hide();
            events.onResolved?.();
          }
          return {
            html: probe.html,
            finalUrl: probe.url,
            ...(probe.pageData === null ? {} : { pageData: probe.pageData }),
            ...(probe.domProduct === null ? {} : { domProduct: probe.domProduct }),
          };
        }

        const challenge =
          detectChallenge(probe.url) ?? (probe.challengeInBody ? "bot" : null);

        if (challenge) {
          seenChallenge = challenge;
          awaitingHuman = true;

          // Hand it to the user rather than trying to get around it.
          if (!windowVisible) {
            windowVisible = true;
            target.show();
            target.focus();
            events.onChallenge?.({ url: probe.url, kind: challenge });
          }
        } else if (seenChallenge && renavigations < MAX_RENAVIGATIONS) {
          // The check has been cleared, but Alibaba leaves you on the
          // interstitial's aftermath rather than returning you to the listing.
          // Nothing will ever navigate back on its own, so we do it — the
          // clearance cookie now lives in this partition, so the reload
          // normally succeeds.
          renavigations++;
          awaitingHuman = false;
          started = Date.now();
          await target.loadURL(url).catch(() => undefined);
          continue;
        }

        if (Date.now() - started > deadline()) {
          throw seenChallenge
            ? new AppError(
                "BOT_CHALLENGE",
                windowVisible
                  ? "The AliExpress check was started but the listing still didn't load. Try again."
                  : "AliExpress blocked this listing before it loaded.",
                seenChallenge,
              )
            : new AppError(
                "PARSE_FAILED",
                "That product page loaded but never showed a product. The listing may have been removed, be unavailable in your region, or AliExpress may be quietly serving this machine an empty page.",
                describeEmptyPage(lastProbe),
              );
        }
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "FETCH_FAILED",
        "Couldn't open that product page.",
        cause instanceof Error ? cause.message : undefined,
      );
    }
  };

  return {
    name: "chromium",
    load(url: string): Promise<LoadedPage> {
      const next = queue.then(
        () => load(url),
        () => load(url),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    dispose(): void {
      if (win && !win.isDestroyed()) win.destroy();
      win = undefined;
    },
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Summarises what the page did contain, so a failure is debuggable from the
 * error alone: which of title/price were present, whether any page state
 * global existed, and where we ended up.
 */
function describeEmptyPage(probe: ProbeResult | undefined): string {
  if (!probe) return "page never became readable";

  const dom = probe.domProduct;
  const parts = [
    `title=${dom?.title ? "yes" : "no"}`,
    `price=${dom?.priceText ? "yes" : "no"}`,
    `images=${dom?.images?.length ?? 0}`,
    `state=${probe.pageData ? "yes" : "no"}`,
  ];

  try {
    parts.push(`host=${new URL(probe.url).host}`);
  } catch {
    // A non-URL location is itself worth not crashing over.
  }

  return parts.join(" ");
}
