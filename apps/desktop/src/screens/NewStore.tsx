import { useEffect, useMemo, useState } from "react";
import {
  AI_PROVIDER_INFO,
  ThemeSchema,
  type NormalizedProduct,
  type SettingsView,
  type Theme,
} from "@repo/shared";
import { ApiError, api, desktop, type CreateStoreResult } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { Field } from "../components/Field.js";
import { ThemePicker } from "../components/ThemePicker.js";
import { useToast } from "../components/Toast.js";

type DeployTarget = "vercel" | "netlify" | "static";

/**
 * Link in, storefront out.
 *
 * Laid out as numbered steps rather than one long form: everything past step 1
 * depends on a successful scrape, and showing twenty disabled inputs before
 * there is a product to describe was the single most confusing thing about the
 * old screen.
 */
export function NewStore({ onCreated }: { onCreated: (storeId: string) => void }) {
  const toast = useToast();

  const [url, setUrl] = useState("");
  const [product, setProduct] = useState<NormalizedProduct | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CreateStoreResult | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [challenge, setChallenge] = useState<{ kind: string } | null>(null);

  const [storeName, setStoreName] = useState("");
  const [tagline, setTagline] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [markup, setMarkup] = useState("2.5");
  const [theme, setTheme] = useState<Theme>(ThemeSchema.parse({}));
  const [useAiCopy, setUseAiCopy] = useState(false);
  const [useAiAltText, setUseAiAltText] = useState(false);
  const [bundleAssets, setBundleAssets] = useState(true);
  const [enableCheckout, setEnableCheckout] = useState(true);
  const [deployTarget, setDeployTarget] = useState<DeployTarget>("vercel");
  const [waitlistEndpoint, setWaitlistEndpoint] = useState("");

  // AliExpress renders listings client-side and sometimes puts a human check in
  // front of them. When that happens the main process opens the page in a real
  // window; all the UI has to do is explain why a window just appeared.
  useEffect(() => desktop.onScrapeChallenge(setChallenge), []);

  useEffect(() => {
    void api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const aiProvider = settings?.ai.provider ?? "openrouter";
  const aiKeyPresent =
    aiProvider === "gemini"
      ? (settings?.gemini.present ?? false)
      : (settings?.openRouter.present ?? false);
  const isPremium = settings?.profile.tier === "premium";

  const retail = useMemo(
    () => (product ? previewRetail(product.price.amountCents, markup) : "—"),
    [product, markup],
  );

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
      const created = await api.createStore({
        url,
        useAiCopy,
        useAiAltText,
        bundleAssets,
        enableCheckout,
        config: {
          storeName,
          tagline,
          supportEmail: supportEmail.trim() || null,
          theme,
          deployTarget,
          pricing: {
            markupMultiplier: Number.parseFloat(markup) || 2.5,
            charmPricing: true,
            currency: product?.price.currency ?? "USD",
          },
          checkout: {
            provider: enableCheckout ? "stripe" : "waitlist",
            // A static host can't run a function, so those stores use links.
            mode: deployTarget === "static" ? "payment_link" : "api",
            waitlistEndpoint: waitlistEndpoint.trim() || null,
          },
        },
      });

      setResult(created);
      toast.show(`${created.store.config.storeName} generated.`);
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
        <span className="text-muted">AliExpress link in, deployable store out</span>
      </div>

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

      {challenge && (
        <Banner title="AliExpress needs you to confirm you're human">
          A browser window has opened with the listing. Complete the check there
          and we'll carry on reading the product automatically — you usually only
          have to do this once.
        </Banner>
      )}

      <Step index={1} title="Paste the product link" state={product ? "done" : "active"}>
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
            onClick={() => void preview()}
          >
            {busy === "preview" ? "Reading…" : "Read product"}
          </button>
        </div>

        {product && <ProductSummary product={product} />}
      </Step>

      {product && (
        <>
          <Step index={2} title="Name and price it" state="active">
            <div className="grid-2">
              <Field label="Store name" htmlFor="store-name">
                <input
                  id="store-name"
                  className="input"
                  value={storeName}
                  onChange={(event) => setStoreName(event.target.value)}
                />
              </Field>

              <Field
                label="Tagline"
                htmlFor="store-tagline"
                hint="One line under the store name. Optional."
              >
                <input
                  id="store-tagline"
                  className="input"
                  value={tagline}
                  onChange={(event) => setTagline(event.target.value)}
                />
              </Field>

              <Field
                label="Support email"
                htmlFor="store-email"
                hint="Shown in the footer, and used as the waitlist fallback."
              >
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
                hint={`Sourced at ${money(product.price.amountCents, product.price.currency)} — sells for about ${retail}`}
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
            </div>
          </Step>

          <Step index={3} title="Choose the look" state="active">
            <ThemePicker theme={theme} onChange={setTheme} />
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              You can change any of this later and watch it update live in the
              store's preview.
            </p>
          </Step>

          <Step index={4} title="Content and assets" state="active">
            <label className="radio">
              <input
                type="checkbox"
                checked={bundleAssets}
                onChange={(event) => setBundleAssets(event.target.checked)}
              />
              <span className="dot" />
              Download the product images into the store
            </label>
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              {bundleAssets
                ? "The images become files in your project and deploy with it — nothing points back at AliExpress."
                : "The store will hotlink AliExpress's CDN. Those URLs can be blocked or changed at any time."}
            </p>

            <label className="radio">
              <input
                type="checkbox"
                checked={useAiCopy}
                onChange={(event) => setUseAiCopy(event.target.checked)}
              />
              <span className="dot" />
              Rewrite the product copy with AI
            </label>

            <label className="radio">
              <input
                type="checkbox"
                checked={useAiAltText}
                onChange={(event) => setUseAiAltText(event.target.checked)}
              />
              <span className="dot" />
              Write image alt text with AI
            </label>

            {(useAiCopy || useAiAltText) && (
              <Banner tone={aiKeyPresent ? "neutral" : "accent"}>
                {aiKeyPresent ? (
                  <>
                    Calls go straight from this machine to{" "}
                    {AI_PROVIDER_INFO[aiProvider].label} on your own key, and are
                    billed to your account. We never proxy them.
                  </>
                ) : (
                  <>
                    No {AI_PROVIDER_INFO[aiProvider].label} key saved. Add one in
                    Settings, or generate anyway — the store still builds and
                    you'll get a warning instead of a failure.
                  </>
                )}
              </Banner>
            )}
          </Step>

          <Step index={5} title="Checkout and hosting" state="active">
            <div className="grid-2">
              <Field
                label="Deploy to"
                htmlFor="store-target"
                hint={
                  deployTarget === "static"
                    ? "Static hosts can't run a checkout endpoint — those stores use Stripe payment links."
                    : "The store ships a /api/checkout function that runs on your own account."
                }
              >
                <select
                  id="store-target"
                  className="input"
                  value={deployTarget}
                  onChange={(event) =>
                    setDeployTarget(event.target.value as DeployTarget)
                  }
                >
                  <option value="vercel">Vercel</option>
                  <option value="netlify">Netlify</option>
                  <option value="static">Any static host</option>
                </select>
              </Field>

              <Field
                label="Waitlist endpoint"
                htmlFor="store-waitlist"
                hint="Where waitlist emails post — your Formspree, Buttondown or own webhook. Falls back to your support email."
              >
                <input
                  id="store-waitlist"
                  className="input"
                  type="url"
                  placeholder="https://formspree.io/f/…"
                  value={waitlistEndpoint}
                  onChange={(event) => setWaitlistEndpoint(event.target.value)}
                />
              </Field>
            </div>

            <label className="radio">
              <input
                type="checkbox"
                checked={enableCheckout}
                onChange={(event) => setEnableCheckout(event.target.checked)}
              />
              <span className="dot" />
              Take payment with Stripe
            </label>

            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              {!enableCheckout
                ? "The buy button captures a waitlist. For validation that's arguably the better signal — you learn whether people want it before you stock anything."
                : isPremium
                  ? "Checkout runs on Stripe's hosted page, against your own account. We take no cut and never see a card."
                  : "Stripe checkout is a premium feature. This store will capture a waitlist instead — upgrade and regenerate to take payments."}
            </p>
          </Step>

          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || storeName.trim().length === 0}
              onClick={() => void create()}
            >
              {busy === "create" ? "Generating…" : "Generate store"}
            </button>
            {busy === "create" && (
              <span className="spinner">
                Scraping, writing files{bundleAssets ? " and downloading images" : ""}…
              </span>
            )}
          </div>
        </>
      )}

      {result && (
        <div className="stack">
          <Banner tone="success" title="Store generated">
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
              className="btn btn-primary"
              onClick={() => onCreated(result.store.id)}
            >
              Open it
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (result.store.outputDir) {
                  void desktop.openPath(result.store.outputDir);
                }
              }}
            >
              Show folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Step({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: "done" | "active" | "idle";
  children: React.ReactNode;
}) {
  const indexClass =
    state === "done"
      ? "step-index step-index-done"
      : state === "idle"
        ? "step-index step-index-idle"
        : "step-index";

  return (
    <section className="step">
      <div className={indexClass} aria-hidden="true">
        {index}
      </div>
      <div>
        <h3 className="step-title">{title}</h3>
        <div className="step-body">{children}</div>
      </div>
    </section>
  );
}

/** What we read off the listing — the cheapest possible way to catch a bad scrape. */
function ProductSummary({ product }: { product: NormalizedProduct }) {
  return (
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
          <div className="text-muted" style={{ fontSize: 13 }}>
            Cost {money(product.price.amountCents, product.price.currency)}
            {product.ratingAverage !== null && (
              <> · {product.ratingAverage.toFixed(1)}★</>
            )}
            {product.ratingCount !== null && (
              <> ({product.ratingCount.toLocaleString()})</>
            )}
            {product.variants.length > 0 && (
              <> · {product.variants.length} variants</>
            )}
            {" · "}
            {product.images.length} images
            {product.shipsFrom && <> · ships from {product.shipsFrom}</>}
          </div>

          {product.images.length > 1 && (
            <div className="thumb-strip">
              {product.images.slice(1, 9).map((image) => (
                <img
                  key={image.url}
                  className="grayscale"
                  src={image.url}
                  alt={image.alt}
                />
              ))}
            </div>
          )}

          {product.description && (
            <p className="card-body" style={{ marginTop: 4 }}>
              {product.description.slice(0, 240)}
              {product.description.length > 240 ? "…" : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveStoreName(title: string): string {
  const firstWords = title.split(/\s+/).slice(0, 2).join(" ");
  return firstWords.replace(/[^\w\s-]/g, "").trim() || "My Store";
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function previewRetail(costCents: number, markup: string): string {
  const multiplier = Number.parseFloat(markup);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "—";
  const marked = Math.round(costCents * multiplier);
  const charmed = marked <= 99 ? 99 : Math.floor(marked / 100) * 100 + 99;
  return `$${(charmed / 100).toFixed(2)}`;
}
