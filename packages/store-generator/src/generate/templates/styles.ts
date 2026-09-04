import type { SiteContext } from "../context.js";

const FONT_STACKS: Record<string, string> = {
  system:
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

interface Preset {
  radius: string;
  surface: string;
  ink: string;
  muted: string;
  border: string;
  headingWeight: string;
  headingTracking: string;
}

const PRESETS: Record<string, Preset> = {
  minimal: {
    radius: "10px",
    surface: "#ffffff",
    ink: "#111827",
    muted: "#6b7280",
    border: "#e5e7eb",
    headingWeight: "600",
    headingTracking: "-0.01em",
  },
  bold: {
    radius: "4px",
    surface: "#ffffff",
    ink: "#0a0a0a",
    muted: "#525252",
    border: "#d4d4d4",
    headingWeight: "800",
    headingTracking: "-0.03em",
  },
  editorial: {
    radius: "2px",
    surface: "#fdfcf9",
    ink: "#1c1917",
    muted: "#78716c",
    border: "#e7e5e4",
    headingWeight: "500",
    headingTracking: "0",
  },
  warm: {
    radius: "16px",
    surface: "#fffaf5",
    ink: "#2b1c12",
    muted: "#8a7160",
    border: "#f0e2d4",
    headingWeight: "650",
    headingTracking: "-0.015em",
  },
  noir: {
    radius: "6px",
    surface: "#111113",
    ink: "#f4f4f5",
    muted: "#a1a1aa",
    border: "#2a2a2e",
    headingWeight: "700",
    headingTracking: "-0.02em",
  },
};

/** Presets a storefront can be built with, for the app's theme picker. */
export const THEME_PRESETS = Object.keys(PRESETS) as (keyof typeof PRESETS)[];

/** True when a preset's ground is dark, so the picker can preview it honestly. */
export function isDarkPreset(preset: string): boolean {
  return preset === "noir";
}

/** Theme tokens are the only generated CSS; the rest of the sheet is constant. */
export function themeCss(ctx: SiteContext): string {
  const { accentColor, fontStack, preset } = ctx.config.theme;
  const tokens = PRESETS[preset] ?? PRESETS.minimal!;
  const font = FONT_STACKS[fontStack] ?? FONT_STACKS.system!;

  return `:root {
  --accent: ${accentColor};
  --accent-ink: ${readableInk(accentColor)};
  --font: ${font};
  --radius: ${tokens.radius};
  --surface: ${tokens.surface};
  --ink: ${tokens.ink};
  --muted: ${tokens.muted};
  --border: ${tokens.border};
  --heading-weight: ${tokens.headingWeight};
  --heading-tracking: ${tokens.headingTracking};
}
`;
}

/**
 * Picks black or white for text sitting on the accent colour, using the WCAG
 * relative-luminance formula so buttons stay readable whatever accent is set.
 */
export function readableInk(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "#111827" : "#ffffff";
}

export function globalCss(): string {
  return `*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background: var(--surface);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 {
  font-weight: var(--heading-weight);
  letter-spacing: var(--heading-tracking);
  line-height: 1.2;
  margin: 0 0 0.5em;
}

a { color: inherit; }

img { max-width: 100%; display: block; }

.wrap {
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 20px;
}

.site-header {
  border-bottom: 1px solid var(--border);
  padding: 18px 0;
}

.site-header .wrap {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.brand {
  font-size: 1.25rem;
  font-weight: var(--heading-weight);
  letter-spacing: var(--heading-tracking);
  text-decoration: none;
}

.brand-tagline {
  color: var(--muted);
  font-size: 0.875rem;
}

.nav {
  display: flex;
  gap: 18px;
  font-size: 0.9375rem;
}

.nav a { text-decoration: none; color: var(--muted); }
.nav a:hover { color: var(--ink); }

.product {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 44px;
  padding: 44px 0;
  align-items: start;
}

@media (max-width: 820px) {
  .product { grid-template-columns: 1fr; gap: 28px; padding: 28px 0; }
}

.gallery-main {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  aspect-ratio: 1 / 1;
  background: #f5f5f5;
}

.gallery-main img { width: 100%; height: 100%; object-fit: cover; }

.gallery-thumbs {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-top: 8px;
  padding: 0;
  list-style: none;
}

.gallery-thumbs button {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) / 1.5);
  overflow: hidden;
  cursor: pointer;
  background: none;
  aspect-ratio: 1 / 1;
  width: 100%;
}

.gallery-thumbs button[aria-current="true"] { border-color: var(--accent); }
.gallery-thumbs img { width: 100%; height: 100%; object-fit: cover; }

.price-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 4px 0 16px;
}

.price { font-size: 1.75rem; font-weight: 700; }
.price-compare { color: var(--muted); text-decoration: line-through; }

.badge {
  display: inline-block;
  background: var(--accent);
  color: var(--accent-ink);
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 3px 10px;
}

.rating { color: var(--muted); font-size: 0.9375rem; margin-bottom: 12px; }
.stars { color: var(--accent); letter-spacing: 2px; }

.highlights { padding-left: 1.1em; margin: 0 0 20px; color: var(--ink); }
.highlights li { margin-bottom: 6px; }

.field { margin-bottom: 16px; }
.field label { display: block; font-size: 0.875rem; color: var(--muted); margin-bottom: 6px; }

select, input[type="number"] {
  font: inherit;
  color: inherit;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  width: 100%;
  max-width: 320px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font: inherit;
  font-weight: 600;
  padding: 13px 22px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  width: 100%;
  max-width: 320px;
}

.btn-primary { background: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { filter: brightness(0.94); }
.btn-secondary { background: transparent; color: var(--ink); border-color: var(--border); }

.btn[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }

.checkout-note {
  font-size: 0.8125rem;
  color: var(--muted);
  margin-top: 10px;
  max-width: 320px;
}

.notice {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  padding: 14px 16px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  font-size: 0.9375rem;
}

.prose { max-width: 68ch; padding: 32px 0; }
.prose h2 { margin-top: 1.6em; }
.prose p { white-space: pre-line; }

.section { border-top: 1px solid var(--border); padding: 32px 0; }

.site-footer {
  border-top: 1px solid var(--border);
  margin-top: 48px;
  padding: 28px 0;
  color: var(--muted);
  font-size: 0.875rem;
}

.site-footer .wrap { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }

.cart-line {
  display: flex;
  align-items: center;
  gap: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 12px;
}

.cart-line img { width: 72px; height: 72px; object-fit: cover; border-radius: calc(var(--radius) / 1.5); }
.cart-line .grow { flex: 1; min-width: 0; }
.cart-line .opts { color: var(--muted); font-size: 0.875rem; }
.cart-total { display: flex; justify-content: space-between; font-weight: 700; font-size: 1.125rem; margin: 20px 0; }

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`;
}

/** Waitlist capture styles, appended to the storefront's global sheet. */
export function waitlistCss(): string {
  return `.waitlist { max-width: 320px; }

.waitlist-form .field { margin-bottom: 12px; }

.waitlist-input {
  font: inherit;
  color: inherit;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  width: 100%;
}

.waitlist-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
`;
}
