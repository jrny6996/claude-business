import { useEffect, useState } from "react";
import type { NormalizedProduct, Store } from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { Field } from "../components/Field.js";

interface CreateResult {
  store: Store;
  warnings: { code: string; message: string }[];
}

const PRESETS = ["minimal", "bold", "editorial"] as const;

/** Paste a link, check what we read, generate the store. */
export function NewStore({ onCreated }: { onCreated: () => void }) {
  const [url, setUrl] = useState("");
  const [product, setProduct] = useState<NormalizedProduct | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

  const [storeName, setStoreName] = useState("");
  const [tagline, setTagline] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [accentColor, setAccentColor] = useState("#ec3013");
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("minimal");
  const [markup, setMarkup] = useState("2.5");
  const [useAiCopy, setUseAiCopy] = useState(false);
  const [enableCheckout, setEnableCheckout] = useState(true);
  const [challenge, setChallenge] = useState<{ kind: string } | null>(null);

  // AliExpress renders listings client-side and sometimes puts a human check in
  // front of them. When that happens the main process opens the page in a real
  // window; all the UI has to do is explain why a window just appeared.
  useEffect(() => desktop.onScrapeChallenge(setChallenge), []);

  const preview = async () => {
    setBusy("preview");
    setError(null);
    setResult(null);
    setChallenge(null);
    try {
      const scraped = (await api.previewProduct(url)) as NormalizedProduct;
      setProduct(scraped);
      if (!storeName) setStoreName(deriveStoreName(scraped.title));
    } catch (cause) {
      setProduct(null);
      setError(cause as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    setError(null);
    try {
      const created = (await api.createStore({
        url,
        useAiCopy,
        enableCheckout,
        config: {
          storeName,
          tagline,
          supportEmail: supportEmail.trim() || null,
          theme: { accentColor, preset, fontStack: "system" },
          pricing: {
            markupMultiplier: Number.parseFloat(markup) || 2.5,
            charmPricing: true,
            currency: "USD",
          },
          checkout: { provider: enableCheckout ? "stripe" : "none" },
        },
      })) as CreateResult;

      setResult(created);
      onCreated();
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="section-head">
        <h2>New store</h2>
        <span className="text-muted">Paste an AliExpress product link</span>
      </div>

      <div className="row row-grow">
        <Field
          label="Product link"
          htmlFor="product-url"
          hint="Open the product page on AliExpress and copy the URL from the address bar."
        >
          <input
            id="product-url"
            className="input"
            type="url"
            placeholder="https://www.aliexpress.com/item/1005006123456789.html"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy !== null || url.trim().length === 0}
          onClick={preview}
        >
          {busy === "preview" ? "Reading…" : "Read product"}
        </button>
      </div>

      {challenge && (
        <Banner title="AliExpress needs you to confirm you're human">
          A browser window has opened with the listing. Complete the check there
          and we'll carry on reading the product automatically — you usually only
          have to do this once.
        </Banner>
      )}

      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
          {(error.code === "BOT_CHALLENGE" ||
            error.code === "CHALLENGE_ABANDONED") && (
            <div style={{ marginTop: 8 }}>
              Try again — the window will reopen so you can finish the check.
            </div>
          )}
        </Banner>
      )}

      {product && (
        <>
          <div className="card">
            <div className="preview">
              {product.images[0] ? (
                <img
                  className="grayscale"
                  src={product.images[0].url}
                  alt={product.images[0].alt}
                />
              ) : (
                <div className="empty">No image</div>
              )}
              <div className="stack-tight">
                <div className="card-kicker">What we read</div>
                <h3 style={{ margin: 0 }}>{product.title}</h3>
                <div className="text-muted">
                  Cost {(product.price.amountCents / 100).toFixed(2)}{" "}
                  {product.price.currency}
                  {product.ratingAverage !== null && (
                    <> · {product.ratingAverage.toFixed(1)} stars</>
                  )}
                  {product.variants.length > 0 && (
                    <> · {product.variants.length} variants</>
                  )}
                  {" · "}
                  {product.images.length} images
                </div>
                {product.description && (
                  <p className="card-body" style={{ marginTop: 8 }}>
                    {product.description.slice(0, 240)}
                    {product.description.length > 240 ? "…" : ""}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="section-head">
            <h3 style={{ margin: 0 }}>Store settings</h3>
          </div>

          <div className="grid-2">
            <Field label="Store name" htmlFor="store-name">
              <input
                id="store-name"
                className="input"
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
              />
            </Field>

            <Field label="Tagline" htmlFor="store-tagline">
              <input
                id="store-tagline"
                className="input"
                value={tagline}
                onChange={(event) => setTagline(event.target.value)}
              />
            </Field>

            <Field label="Support email" htmlFor="store-email">
              <input
                id="store-email"
                className="input"
                type="email"
                value={supportEmail}
                onChange={(event) => setSupportEmail(event.target.value)}
              />
            </Field>

            <Field
              label="Retail markup"
              htmlFor="store-markup"
              hint={`Sells for about ${previewRetail(product.price.amountCents, markup)}`}
            >
              <input
                id="store-markup"
                className="input"
                type="number"
                min="1"
                max="50"
                step="0.1"
                value={markup}
                onChange={(event) => setMarkup(event.target.value)}
              />
            </Field>

            <Field label="Storefront accent" htmlFor="store-accent">
              <input
                id="store-accent"
                className="input"
                type="text"
                value={accentColor}
                onChange={(event) => setAccentColor(event.target.value)}
              />
            </Field>

            <Field label="Storefront style" htmlFor="store-preset">
              <select
                id="store-preset"
                className="input"
                value={preset}
                onChange={(event) =>
                  setPreset(event.target.value as (typeof PRESETS)[number])
                }
              >
                {PRESETS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="stack-tight">
            <label className="radio">
              <input
                type="checkbox"
                checked={enableCheckout}
                onChange={(event) => setEnableCheckout(event.target.checked)}
              />
              <span className="dot" />
              Set up Stripe checkout with my own Stripe key
            </label>

            <label className="radio">
              <input
                type="checkbox"
                checked={useAiCopy}
                onChange={(event) => setUseAiCopy(event.target.checked)}
              />
              <span className="dot" />
              Rewrite the product copy with my own OpenRouter key
            </label>
          </div>

          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || storeName.trim().length === 0}
              onClick={create}
            >
              {busy === "create" ? "Generating…" : "Generate store"}
            </button>
          </div>
        </>
      )}

      {result && (
        <div className="stack">
          <Banner tone="neutral" title="Store generated">
            <div className="mono" style={{ marginTop: 4 }}>
              {result.store.outputDir}
            </div>
          </Banner>

          {result.warnings.length > 0 && (
            <Banner
              title="Generated with warnings"
              items={result.warnings.map((warning) => warning.message)}
            />
          )}

          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (result.store.outputDir) void desktop.openPath(result.store.outputDir);
              }}
            >
              Open folder
            </button>
            {result.store.config.checkout.paymentLinkUrl && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void desktop.openExternal(
                    result.store.config.checkout.paymentLinkUrl as string,
                  )
                }
              >
                Test Stripe checkout
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function deriveStoreName(title: string): string {
  const firstWords = title.split(/\s+/).slice(0, 2).join(" ");
  return firstWords.replace(/[^\w\s-]/g, "").trim() || "My Store";
}

function previewRetail(costCents: number, markup: string): string {
  const multiplier = Number.parseFloat(markup);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "—";
  const marked = Math.round(costCents * multiplier);
  const charmed = marked <= 99 ? 99 : Math.floor(marked / 100) * 100 + 99;
  return `$${(charmed / 100).toFixed(2)}`;
}
