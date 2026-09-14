import { z } from "zod";

/**
 * A validated, nested representation of a storefront's custom CSS.
 *
 * Custom styling arrives from two places that are equally untrustworthy: a file
 * the user uploads, and whatever a language model returns. Storing either as a
 * string means the first time anyone finds out it was malformed is when a
 * generated store renders wrong, in the browser, after a deploy.
 *
 * So CSS is held as a tree — rules containing declarations and nested rules —
 * and only serialised to text at generation time. The tree is what gets
 * validated, diffed, merged and stored; the text is a build artifact. That also
 * makes the AI path checkable: the model is asked for JSON matching this
 * schema, so a bad answer fails parsing here rather than producing a stylesheet
 * nobody reads until it is live.
 *
 * Nesting is native CSS nesting (`&`), which every target browser supports and
 * Astro ships through untouched.
 */

/** Properties that do nothing for a storefront and plenty for an attacker. */
const BANNED_PROPERTIES = new Set([
  "behavior",
  "-moz-binding",
  "expression",
]);

/**
 * `url()` targets allowed in a storefront's custom CSS.
 *
 * A remote `url()` in a stylesheet is a GET request the page makes on render —
 * it works as a tracking pixel and, on a page that has a cart, as a signal that
 * a particular visitor reached a particular state. A store owner writing their
 * own CSS can still reference their own bundled assets and inline data, which
 * covers backgrounds and fonts; anything else has to be hosted by them and
 * referenced from their own project, deliberately, not smuggled in by a model.
 */
const ALLOWED_URL = /^(?:\/|\.{1,2}\/|data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,)/;

const URL_CALL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** CSS identifiers, `&`, and the punctuation selectors are built from. */
const SELECTOR_ALLOWED = /^[\w\s&.#:,>+~[\]="'()%\-*|^$]+$/;

const PROPERTY_PATTERN = /^-{0,2}[a-zA-Z][\w-]*$/;

function checkValue(value: string, ctx: z.RefinementCtx): void {
  const lowered = value.toLowerCase();

  // `@import` inside a value is the classic way to pull a whole remote
  // stylesheet in through a hole meant for a colour.
  if (lowered.includes("@import")) {
    ctx.addIssue({
      code: "custom",
      message: "@import isn't allowed in custom CSS — it fetches a remote stylesheet.",
    });
  }

  if (lowered.includes("javascript:")) {
    ctx.addIssue({ code: "custom", message: "javascript: URLs aren't allowed." });
  }

  for (const match of value.matchAll(URL_CALL)) {
    const target = match[2] ?? "";
    if (!ALLOWED_URL.test(target)) {
      ctx.addIssue({
        code: "custom",
        message: `url(${target}) must be a project-relative path or an inline data: image.`,
      });
    }
  }
}

/** One `property: value` pair. */
export const CssDeclarationSchema = z
  .object({
    property: z
      .string()
      .min(1)
      .max(80)
      .regex(PROPERTY_PATTERN, "expected a CSS property name like 'font-size'"),
    value: z.string().min(1).max(2000),
    /** `!important`, kept as a flag so it can't be smuggled through the value. */
    important: z.boolean().default(false),
  })
  .superRefine((declaration, ctx) => {
    if (BANNED_PROPERTIES.has(declaration.property.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        message: `'${declaration.property}' isn't allowed in custom CSS.`,
        path: ["property"],
      });
    }
    checkValue(declaration.value, ctx);
  });
export type CssDeclaration = z.infer<typeof CssDeclarationSchema>;

export interface CssRule {
  /**
   * A selector, or an at-rule prelude when it starts with `@`.
   *
   * Only conditional group rules are accepted — `@media`, `@supports`,
   * `@container`, `@layer` — because those contain nested rules and are what a
   * responsive tweak actually needs. `@import` is refused; it is the one at-rule
   * whose whole job is fetching something else.
   */
  selector: string;
  declarations: CssDeclaration[];
  nested: CssRule[];
}

const NESTABLE_AT_RULES = ["@media", "@supports", "@container", "@layer"];

/** How deep nesting may go before it is a mistake rather than a style. */
const MAX_DEPTH = 6;

export const CssRuleSchema: z.ZodType<CssRule> = z.lazy(() =>
  z
    .object({
      selector: z
        .string()
        .min(1)
        .max(400)
        .superRefine((selector, ctx) => {
          const trimmed = selector.trim();
          if (trimmed.startsWith("@")) {
            const name = trimmed.split(/[\s(]/)[0]!.toLowerCase();
            if (!NESTABLE_AT_RULES.includes(name)) {
              ctx.addIssue({
                code: "custom",
                message: `${name} isn't allowed — only ${NESTABLE_AT_RULES.join(", ")} may wrap rules.`,
              });
            }
            return;
          }
          if (!SELECTOR_ALLOWED.test(trimmed)) {
            ctx.addIssue({
              code: "custom",
              message: `'${selector}' isn't a selector this schema accepts.`,
            });
          }
        }),
      declarations: z.array(CssDeclarationSchema).max(200).default([]),
      nested: z.array(CssRuleSchema).max(200).default([]),
    })
    .superRefine((rule, ctx) => {
      if (depthOf(rule) > MAX_DEPTH) {
        ctx.addIssue({
          code: "custom",
          message: `Custom CSS nests deeper than ${MAX_DEPTH} levels.`,
          path: ["nested"],
        });
      }
    }),
);

/** Depth of a rule tree, counting the rule itself as 1. */
export function depthOf(rule: CssRule): number {
  return 1 + Math.max(0, ...rule.nested.map(depthOf));
}

/**
 * A storefront's whole custom stylesheet.
 *
 * `source` records where it came from, which the UI shows and which decides
 * whether "Regenerate with AI" is offered — regenerating over a file someone
 * hand-wrote would silently discard their work.
 */
export const CustomCssSchema = z.object({
  source: z.enum(["upload", "ai", "manual"]).default("manual"),
  /** What the user asked the model for, kept so it can be refined, not retyped. */
  brief: z.string().max(2000).default(""),
  rules: z.array(CssRuleSchema).max(400).default([]),
});
export type CustomCss = z.infer<typeof CustomCssSchema>;

export const EMPTY_CUSTOM_CSS: CustomCss = {
  source: "manual",
  brief: "",
  rules: [],
};

/**
 * Renders the tree as a stylesheet.
 *
 * Deterministic on purpose: the same tree must produce byte-identical CSS every
 * time, or every regenerate shows up as a diff in the user's git history and
 * as a changed file to redeploy.
 */
export function renderCss(css: CustomCss, indent = ""): string {
  return css.rules.map((rule) => renderRule(rule, indent)).join("\n");
}

function renderRule(rule: CssRule, indent: string): string {
  const inner = indent + "  ";
  const body = [
    ...rule.declarations.map(
      ({ property, value, important }) =>
        `${inner}${property}: ${value}${important ? " !important" : ""};`,
    ),
    ...rule.nested.map((child) => renderRule(child, inner)),
  ];

  // An empty rule is valid CSS and pure noise in a file someone has to read.
  if (body.length === 0) return "";

  return `${indent}${rule.selector.trim()} {\n${body.join("\n")}\n${indent}}`;
}
