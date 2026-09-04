# Modernist design system

Vendored from the Claude Design project **"App and landing page design"**
(`5bacc530-fe6a-4e80-9f40-1f1d138d1a6b`). `styles.css` is the source of truth
and is consumed unmodified by both `apps/desktop` and `apps/landing`.

Flat, architectural, set entirely in Archivo: a near-mono red on a light
ground, a visible modular grid, **zero corner radius** and strong 2px rules.
Nothing floats and nothing is decorated — alignment and the strength of the
dividers do the organising.

## Scope

This system dresses **our** surfaces: the desktop app and the marketing
landing page. It is deliberately _not_ applied to generated storefronts —
those carry their own themeable token set (accent colour, font stack, preset)
that the end user configures per store, in
`packages/store-generator/src/generate/templates/styles.ts`.

## Rules that are easy to break

- **Never hard-code a hex, font name, or px value the tokens already carry.**
  Use `var(--color-*)`, `var(--font-*)`, `var(--space-*)`, `var(--radius-*)`,
  `var(--shadow-*)`.
- **No rounded corners anywhere.** `--radius-md` is `0` on purpose.
- **Flush left.** Headings, body copy, and labels inside wide buttons. A button
  wider than its label starts the text at the left padding edge — never
  centered. That is what `.btn-block` does.
- **Keep the rules strong.** 2px dividers between major sections; don't soften
  them to hairlines or replace them with whitespace.
- **Accent sparingly** — the primary action and small emphasis only. For
  paragraph-size text in the accent use `--color-accent-700`, since the
  accent-to-ground pair is tuned to 3:1 (chrome and large text, not body copy).
- **Photographs go through `.grayscale`.** Never tint or colorize imagery.
- Prefer ramp steps (`--color-accent-600`, `--color-neutral-300`) over ad-hoc
  `color-mix()`.
- Icons are [Lucide](https://lucide.dev).

## Components

| Class                                                                                    | What it is                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.btn-icon` / `.btn-block`   | Actions; primary is a solid accent fill                  |
| `.tag` + `.tag-accent` / `.tag-accent-2` / `.tag-neutral` / `.tag-outline`               | Small labels tinted from the ramps                       |
| `.field` + `label`, `.input`, `.radio` + `.dot`, `.seg` + `.seg-opt`                     | Form fields and choices on native elements, no script    |
| `.card` + `.card-kicker` / `.card-title` / `.card-body` / `.card-meta`; `.elev-sm/md/lg` | Surface-filled cards and elevation                       |
| `.nav` + `.nav-brand`                                                                    | The header bar                                           |
| `.table`                                                                                 | Data tables with themed header and row rules             |
| `.dialog-backdrop` + `.dialog` (+ `.dialog-title/-body/-actions`)                        | A modal at the top elevation                             |
| `.hr`                                                                                    | A strong 2px horizontal rule                             |
| `.grayscale`                                                                             | Image wrapper — every content photograph goes through it |

Interaction states are built in (hover tints, pressed states from the accent
ramp, a 2px accent `:focus-visible` ring, accent `::selection`, 45% opacity
when disabled). Don't restyle them per page.

## Updating

Re-pull with `DesignSync` against the project above rather than hand-editing
`styles.css`, so this copy never drifts from the design project.
