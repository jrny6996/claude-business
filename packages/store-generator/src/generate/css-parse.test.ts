import {
  renderCss,
  CustomCssSchema,
  StoreConfigSchema,
  type NormalizedProduct,
} from "@repo/shared";
import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { parseCss } from "./css-parse.js";
import { themeCss } from "./templates/styles.js";

const PRODUCT: NormalizedProduct = {
  sourceId: "1005006123456789",
  sourceUrl: "https://www.aliexpress.com/item/1005006123456789.html",
  title: "Wireless Earbuds Pro",
  description: "Great earbuds.",
  highlights: ["40h battery"],
  price: { amountCents: 1899, currency: "USD" },
  compareAtPrice: null,
  images: [{ url: "https://ae01.alicdn.com/kf/one.jpg", alt: "one" }],
  variants: [],
  ratingAverage: 4.7,
  ratingCount: 2841,
  shipsFrom: "China",
  scrapedAt: "2026-09-04T00:00:00.000Z",
};

describe("parseCss", () => {
  it("reads declarations and nested rules into a tree", () => {
    const { css } = parseCss(`
      .product { color: #111; font-size: 18px;
        & .price { font-weight: 700; }
      }
    `);

    expect(css.rules).toHaveLength(1);
    expect(css.rules[0]!.selector).toBe(".product");
    expect(css.rules[0]!.declarations).toEqual([
      { property: "color", value: "#111", important: false },
      { property: "font-size", value: "18px", important: false },
    ]);
    expect(css.rules[0]!.nested[0]!.selector).toBe("& .price");
  });

  it("lifts !important into a flag so the value stays a value", () => {
    const { css } = parseCss(".a { color: red !important; }");

    expect(css.rules[0]!.declarations[0]).toEqual({
      property: "color",
      value: "red",
      important: true,
    });
  });

  it("keeps a brace that lives inside a string", () => {
    const { css } = parseCss(`.a::after { content: "}"; color: red; }`);

    expect(css.rules[0]!.declarations).toEqual([
      { property: "content", value: '"}"', important: false },
      { property: "color", value: "red", important: false },
    ]);
  });

  it("keeps a semicolon inside url() and data: values", () => {
    const { css } = parseCss(
      `.a { background: url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="); }`,
    );

    expect(css.rules[0]!.declarations).toHaveLength(1);
  });

  it("nests media queries as rules", () => {
    const { css } = parseCss(`@media (max-width: 600px) { .a { display: none; } }`);

    expect(css.rules[0]!.selector).toBe("@media (max-width: 600px)");
    expect(css.rules[0]!.nested[0]!.selector).toBe(".a");
  });

  it("drops comments without losing the braces they contain", () => {
    const { css } = parseCss(`/* } not a brace */ .a { color: red; }`);

    expect(css.rules).toHaveLength(1);
    expect(css.rules[0]!.selector).toBe(".a");
  });

  it("reports a fragment it could not place instead of dropping it silently", () => {
    const { skipped } = parseCss(`color: red; .a { color: blue; }`);

    expect(skipped.join(" ")).toContain("not inside a rule");
  });
});

/**
 * The refusals. Custom CSS arrives from an uploaded file or from a model, and
 * both are untrusted input that ends up in a stylesheet the store owner ships
 * to their own customers.
 */
describe("what custom CSS refuses", () => {
  it("refuses @import, which fetches a remote stylesheet", () => {
    expect(() => parseCss(`.a { background: red; }`)).not.toThrow();
    expect(() =>
      CustomCssSchema.parse({
        rules: [
          {
            selector: ".a",
            declarations: [{ property: "background", value: "@import url(http://x/a.css)" }],
            nested: [],
          },
        ],
      }),
    ).toThrow(/@import/);
  });

  it("refuses a remote url(), which renders as a tracking pixel", () => {
    expect(() =>
      CustomCssSchema.parse({
        rules: [
          {
            selector: ".a",
            declarations: [
              { property: "background", value: "url(https://tracker.example/p.gif)" },
            ],
            nested: [],
          },
        ],
      }),
    ).toThrow(/project-relative/);
  });

  it("allows a project-relative url() and an inline data: image", () => {
    const parsed = CustomCssSchema.parse({
      rules: [
        {
          selector: ".a",
          declarations: [
            { property: "background", value: "url(/images/hero.jpg)" },
            { property: "list-style-image", value: "url(./bullet.png)" },
          ],
          nested: [],
        },
      ],
    });

    expect(parsed.rules[0]!.declarations).toHaveLength(2);
  });

  it("refuses javascript: values", () => {
    expect(() =>
      CustomCssSchema.parse({
        rules: [
          {
            selector: ".a",
            declarations: [{ property: "background", value: "url(javascript:alert(1))" }],
            nested: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses legacy script-executing properties", () => {
    expect(() =>
      CustomCssSchema.parse({
        rules: [
          {
            selector: ".a",
            declarations: [{ property: "behavior", value: "url(#default#time2)" }],
            nested: [],
          },
        ],
      }),
    ).toThrow(/behavior/);
  });

  it("refuses an at-rule that isn't a conditional group", () => {
    expect(() =>
      CustomCssSchema.parse({
        rules: [{ selector: "@import url(x.css)", declarations: [], nested: [] }],
      }),
    ).toThrow(/@import/);
  });
});

describe("renderCss", () => {
  it("round-trips parse → render → parse to the same tree", () => {
    const source = `
      .card { padding: 16px; border: 2px solid #000;
        & h2 { font-size: 24px; }
        @media (max-width: 600px) { & { padding: 8px; } }
      }
    `;

    const first = parseCss(source).css;
    const second = parseCss(renderCss(first)).css;

    expect(second.rules).toEqual(first.rules);
  });

  it("is byte-stable, so a regenerate isn't a spurious diff", () => {
    const { css } = parseCss(".a { color: red; & .b { color: blue; } }");

    expect(renderCss(css)).toBe(renderCss(css));
    expect(renderCss(css)).toBe(
      [".a {", "  color: red;", "  & .b {", "    color: blue;", "  }", "}"].join("\n"),
    );
  });

  it("writes !important back out", () => {
    const { css } = parseCss(".a { color: red !important; }");

    expect(renderCss(css)).toContain("color: red !important;");
  });

  it("omits a rule with nothing in it", () => {
    const { css } = parseCss(".empty { } .a { color: red; }");

    expect(renderCss(css)).not.toContain(".empty");
  });
});

/** The generated stylesheet is where all of this has to actually land. */
describe("custom CSS in a generated store", () => {
  it("appends after the preset tokens, so it can override them", () => {
    const config = StoreConfigSchema.parse({
      storeName: "CSS Co",
      theme: { customCss: parseCss(".buy { background: #0f0; }").css },
    });

    const css = themeCss(buildContext(config, PRODUCT));

    expect(css.indexOf(".buy")).toBeGreaterThan(css.indexOf("--accent:"));
    expect(css).toContain("background: #0f0;");
  });

  it("emits nothing at all when there is no custom CSS", () => {
    const config = StoreConfigSchema.parse({ storeName: "Plain Co" });
    const css = themeCss(buildContext(config, PRODUCT));

    expect(css).not.toContain("Custom CSS");
  });
});
