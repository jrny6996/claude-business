import type { Theme } from "@repo/shared";
// Imported from the package's `/theme` subpath, not its barrel: the barrel
// re-exports generate/ and assets/, which pull in `node:fs/promises`. Vite
// externalizes that for the browser, so the renderer's module graph threw on
// load and the window came up blank.
import { THEME_PRESET_TOKENS } from "@repo/store-generator/theme";
import { Field } from "./Field.js";

/**
 * Theme controls, shared by the New store flow and the store detail screen.
 *
 * The presets are shown as miniatures rather than a `<select>` of five words:
 * "editorial" and "warm" mean nothing until you see what they do, and the
 * whole point of the preview is that the user can see before they commit.
 *
 * Each miniature is drawn from the generator's own preset tokens — the
 * storefront's palette, deliberately not our Modernist tokens, because our
 * brand must not leak into the user's shop.
 */
export const PRESETS: Theme["preset"][] = [
  "minimal",
  "bold",
  "editorial",
  "warm",
  "noir",
];

export const FONTS: Theme["fontStack"][] = ["system", "serif", "mono"];

/**
 * Read from the generator itself rather than restated here, so a preset's
 * miniature can never drift from the store it describes.
 */
const art = (preset: Theme["preset"]) =>
  THEME_PRESET_TOKENS[preset] ?? THEME_PRESET_TOKENS.minimal!;

const FONT_LABEL: Record<Theme["fontStack"], string> = {
  system: "System sans",
  serif: "Serif",
  mono: "Monospace",
};

export function ThemePicker({
  theme,
  disabled = false,
  onChange,
}: {
  theme: Theme;
  disabled?: boolean;
  onChange: (theme: Theme) => void;
}) {
  return (
    <div className="stack-tight">
      <div className="field">
        <label htmlFor="theme-preset-grid">Preset</label>
        <div className="theme-grid" id="theme-preset-grid">
          {PRESETS.map((preset) => {
            const tokens = art(preset);
            return (
              <button
                key={preset}
                type="button"
                className="theme-swatch"
                aria-pressed={theme.preset === preset}
                disabled={disabled}
                onClick={() => onChange({ ...theme, preset })}
              >
                <span
                  className="theme-swatch-art"
                  style={{ background: tokens.surface }}
                  aria-hidden="true"
                >
                  <span
                    className="theme-swatch-bar"
                    style={{ background: tokens.ink, borderRadius: tokens.radius }}
                  />
                  <span
                    className="theme-swatch-btn"
                    style={{
                      background: theme.accentColor,
                      borderRadius: tokens.radius,
                    }}
                  />
                </span>
                <span className="theme-swatch-label">{preset}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid-2">
        <Field
          label="Accent colour"
          htmlFor="theme-accent"
          hint="Used for buttons and prices in your storefront."
        >
          <input
            id="theme-accent"
            className="input"
            type="color"
            value={theme.accentColor}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...theme, accentColor: event.target.value })
            }
          />
        </Field>

        <Field label="Typeface" htmlFor="theme-font">
          <select
            id="theme-font"
            className="input"
            value={theme.fontStack}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...theme,
                fontStack: event.target.value as Theme["fontStack"],
              })
            }
          >
            {FONTS.map((font) => (
              <option key={font} value={font}>
                {FONT_LABEL[font]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}
