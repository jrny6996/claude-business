import { AppError } from "@repo/shared";
import { detectChallenge, detectChallengeInHtml } from "./challenge.js";
import { fetchPage, type FetchPageOptions } from "./fetch.js";

/**
 * Where a product page's contents come from.
 *
 * Two implementations exist: a plain HTTP client (fast, used in tests and as a
 * first attempt) and a real Chromium window in the desktop app. The second is
 * necessary because AliExpress renders product data client-side — the served
 * HTML contains no title, price or images at all — and because it puts an
 * anti-bot interstitial in front of non-browser clients.
 */
export interface LoadedPage {
  html: string;
  finalUrl: string;
  /**
   * Parsed `window.runParams` when the source could read it from a live page.
   * Preferred over `html`, since it is the same object the real storefront uses.
   */
  pageData?: unknown;
  /**
   * Values read straight off the rendered page.
   *
   * A last line of defence: AliExpress has more than one way of exposing its
   * page state, and which one is populated varies by rollout. The rendered DOM
   * is the one thing that is true whenever a human can see the product.
   */
  domProduct?: DomProduct;
}

/** Text scraped from the rendered page, parsed downstream. */
export interface DomProduct {
  title?: string | null;
  priceText?: string | null;
  compareAtText?: string | null;
  images?: string[];
  ratingText?: string | null;
  ratingCountText?: string | null;
  shipsFrom?: string | null;
  description?: string | null;
}

export interface PageSource {
  load(url: string): Promise<LoadedPage>;
  /** Human-readable name, for error detail. */
  readonly name: string;
}

/** Plain HTTP. Cheap, and works for any source that renders server-side. */
export function httpPageSource(options: FetchPageOptions = {}): PageSource {
  return {
    name: "http",
    async load(url: string): Promise<LoadedPage> {
      const page = await fetchPage(url, options);

      const challenge =
        detectChallenge(page.finalUrl) ?? detectChallengeInHtml(page.html);
      if (challenge) {
        throw new AppError(
          "BOT_CHALLENGE",
          "AliExpress won't serve this listing to a plain web request.",
          challenge,
        );
      }

      return page;
    },
  };
}
