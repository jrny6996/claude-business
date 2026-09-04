import { useEffect, useState } from "react";
import type { Store, Theme } from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { Field } from "../components/Field.js";

const PRESETS: Theme["preset"][] = [
  "minimal",
  "bold",
  "editorial",
  "warm",
  "noir",
];
const FONTS: Theme["fontStack"][] = ["system", "serif", "mono"];

/**
 * Live preview of a generated store.
 *
 * The iframe points at the store's own Astro dev server, so this is the real
 * site — not a mock-up that can drift from what deploys. Theme edits rewrite
 * the store's theme tokens and data island on disk; Astro's HMR pushes them
 * into the frame without a restart.
 */
export function Preview({
  store,
  onClose,
  onChanged,
}: {
  store: Store;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting preview…");
  const [error, setError] = useState<ApiError | null>(null);
  const [theme, setTheme] = useState<Theme>(store.config.theme);
  const [savingTheme, setSavingTheme] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!store.outputDir) {
        setError(
          new ApiError({
            code: "VALIDATION_FAILED",
            message: "This store hasn't been generated to disk yet.",
          }),
        );
        return;
      }

      try {
        const existing = await desktop.previewStatus(store.id);
        if (cancelled) return;

        if (existing) {
          setUrl(existing.url);
          setStatus("");
          return;
        }

        setStatus("Starting Astro dev server… first run can take a moment.");
        const started = await desktop.startPreview(store.id, store.outputDir);
        if (cancelled) return;

        setUrl(started.url);
        setStatus("");
      } catch (cause) {
        if (!cancelled) setError(cause as ApiError);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [store.id, store.outputDir]);

  const applyTheme = async (next: Theme) => {
    setTheme(next);
    setSavingTheme(true);
    setError(null);
    try {
      await api.updateTheme(store.id, next);
      onChanged();
      // HMR usually catches the CSS change on its own; the nudge covers the
      // data island, which Astro treats as a full reload.
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setSavingTheme(false);
    }
  };

  return (
    <div className="stack">
      <div className="section-head">
        <h2>{store.config.storeName}</h2>
        <div className="inline-actions">
          {url && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void desktop.openExternal(url)}
            >
              Open in browser
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void desktop.stopPreview(store.id);
              onClose();
            }}
          >
            Close preview
          </button>
        </div>
      </div>

      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      <div className="preview-layout">
        <div className="preview-frame">
          {url ? (
            <iframe
              key={reloadKey}
              src={url}
              title={`${store.config.storeName} preview`}
              sandbox="allow-scripts allow-forms allow-same-origin"
            />
          ) : (
            <div className="empty" style={{ padding: "var(--space-8)" }}>
              {status}
            </div>
          )}
        </div>

        <aside className="stack-tight">
          <div className="card-kicker">Theme</div>

          <Field label="Preset" htmlFor="theme-preset">
            <select
              id="theme-preset"
              className="input"
              value={theme.preset}
              disabled={savingTheme}
              onChange={(event) =>
                void applyTheme({
                  ...theme,
                  preset: event.target.value as Theme["preset"],
                })
              }
            >
              {PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Accent" htmlFor="theme-accent">
            <input
              id="theme-accent"
              className="input"
              type="color"
              value={theme.accentColor}
              disabled={savingTheme}
              onChange={(event) =>
                void applyTheme({ ...theme, accentColor: event.target.value })
              }
            />
          </Field>

          <Field label="Type" htmlFor="theme-font">
            <select
              id="theme-font"
              className="input"
              value={theme.fontStack}
              disabled={savingTheme}
              onChange={(event) =>
                void applyTheme({
                  ...theme,
                  fontStack: event.target.value as Theme["fontStack"],
                })
              }
            >
              {FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </Field>

          <p className="text-muted" style={{ fontSize: 12 }}>
            Changes are written to the store on disk and reload here. This is the
            real Astro site, so what you see is what deploys.
          </p>

          {store.config.checkout.provider === "waitlist" && (
            <Banner tone="neutral" title="Waitlist store">
              Free stores capture emails instead of taking payment. Upgrade to
              premium and regenerate to enable Stripe checkout.
            </Banner>
          )}
        </aside>
      </div>
    </div>
  );
}
