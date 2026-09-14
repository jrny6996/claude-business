import {
  CustomCssSchema,
  type CssDeclaration,
  type CssRule,
  type CustomCss,
} from "@repo/shared";

/**
 * Parses a stylesheet into the validated tree `CustomCssSchema` describes.
 *
 * Hand-written rather than pulled from a CSS library on purpose. The schema
 * deliberately accepts a *subset* of CSS — nested rules, declarations, and four
 * conditional at-rules — so a full parser would hand back a lot of shapes that
 * have no representation here, and the interesting work would still be mapping
 * its AST onto ours and rejecting the rest. This walks the text once and emits
 * exactly the accepted subset.
 *
 * What it drops, quietly, because none of it survives into the tree anyway:
 * comments. What it refuses, loudly, via the schema: everything in
 * `css.ts`'s banned list.
 */
export interface CssParseResult {
  css: CustomCss;
  /** Non-fatal: things skipped, with a reason, so the UI can show them. */
  skipped: string[];
}

class Cursor {
  constructor(
    readonly text: string,
    public index = 0,
  ) {}

  get done(): boolean {
    return this.index >= this.text.length;
  }

  peek(): string {
    return this.text[this.index] ?? "";
  }

  skipWhitespace(): void {
    while (!this.done && /\s/.test(this.peek())) this.index += 1;
  }
}

/** Strips comments first; they can otherwise hide a brace from the scanner. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Reads up to the next `{`, `}` or `;` that isn't inside a string or brackets.
 *
 * Tracking quotes matters: `content: "}"` is a perfectly ordinary declaration
 * and a naive brace count ends the rule in the middle of it.
 */
function readUntilDelimiter(cursor: Cursor): { text: string; delimiter: string } {
  let out = "";
  let quote: string | null = null;
  let depth = 0;

  while (!cursor.done) {
    const char = cursor.peek();

    if (quote) {
      if (char === quote && cursor.text[cursor.index - 1] !== "\\") quote = null;
      out += char;
      cursor.index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      cursor.index += 1;
      continue;
    }

    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);

    if (depth === 0 && (char === "{" || char === "}" || char === ";")) {
      cursor.index += 1;
      return { text: out, delimiter: char };
    }

    out += char;
    cursor.index += 1;
  }

  return { text: out, delimiter: "" };
}

function parseDeclaration(raw: string): CssDeclaration | null {
  const colon = raw.indexOf(":");
  if (colon === -1) return null;

  const property = raw.slice(0, colon).trim();
  let value = raw.slice(colon + 1).trim();
  if (!property || !value) return null;

  // `!important` becomes a flag so it round-trips through the schema rather
  // than riding along inside the value, where nothing would validate it.
  let important = false;
  const bang = /!\s*important\s*$/i;
  if (bang.test(value)) {
    important = true;
    value = value.replace(bang, "").trim();
  }
  if (!value) return null;

  return { property, value, important };
}

function parseBlock(cursor: Cursor, skipped: string[]): {
  declarations: CssDeclaration[];
  nested: CssRule[];
} {
  const declarations: CssDeclaration[] = [];
  const nested: CssRule[] = [];

  while (!cursor.done) {
    cursor.skipWhitespace();
    if (cursor.peek() === "}") {
      cursor.index += 1;
      break;
    }

    const { text, delimiter } = readUntilDelimiter(cursor);
    const trimmed = text.trim();

    if (delimiter === "{") {
      const block = parseBlock(cursor, skipped);
      if (trimmed) {
        nested.push({ selector: trimmed, ...block });
      }
      continue;
    }

    if (delimiter === "}" || delimiter === "") {
      // A trailing declaration with no semicolon before the closing brace.
      const declaration = trimmed ? parseDeclaration(trimmed) : null;
      if (declaration) declarations.push(declaration);
      if (trimmed && !declaration) skipped.push(trimmed.slice(0, 80));
      break;
    }

    if (!trimmed) continue;

    // An at-rule with no block — `@import url(...)` and friends. The schema
    // would refuse it anyway; saying so here names the line.
    if (trimmed.startsWith("@")) {
      skipped.push(`${trimmed.slice(0, 80)} — at-rules without a block are dropped`);
      continue;
    }

    const declaration = parseDeclaration(trimmed);
    if (declaration) declarations.push(declaration);
    else skipped.push(trimmed.slice(0, 80));
  }

  return { declarations, nested };
}

/**
 * Parses stylesheet text. Throws a `ZodError` if what it finds isn't allowed —
 * the caller turns that into a `VALIDATION_FAILED` naming the offending rule.
 */
export function parseCss(
  text: string,
  meta: { source: CustomCss["source"]; brief?: string } = { source: "upload" },
): CssParseResult {
  const cursor = new Cursor(stripComments(text));
  const skipped: string[] = [];
  const { declarations, nested } = parseBlock(cursor, skipped);

  // Declarations at the top level have no rule to belong to; CSS has no such
  // thing, so they are someone's stray fragment rather than a style.
  for (const orphan of declarations) {
    skipped.push(`${orphan.property}: ${orphan.value} — not inside a rule`);
  }

  return {
    css: CustomCssSchema.parse({
      source: meta.source,
      brief: meta.brief ?? "",
      rules: nested,
    }),
    skipped,
  };
}
