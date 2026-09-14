import { useCallback, useEffect, useState } from "react";
import type { Store } from "@repo/shared";
import { ApiError, api, type CopyRewriteResult } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { useToast } from "../components/Toast.js";
import { StoreDetail } from "./StoreDetail.js";

/** The codes that mean "the user has no usable AI key", whichever provider. */
const MISSING_KEY_CODES = [
  "MISSING_OPENROUTER_KEY",
  "MISSING_GEMINI_KEY",
  "MISSING_AI_KEY",
];

/**
 * The generated stores, as a list you can scan.
 *
 * This used to be a table whose last column held five ghost buttons per row,
 * which made every store look like a settings panel. Actions live on the
 * detail screen now; the list's job is to let you find a store and see its
 * state at a glance.
 */
export function Stores({
  reloadKey,
  openStoreId,
  onOpenStore,
  onNeedsAiKey,
}: {
  reloadKey: number;
  openStoreId: string | null;
  onOpenStore: (storeId: string | null) => void;
  /** Called when an AI action can't run because no key is set up. */
  onNeedsAiKey: () => void;
}) {
  const toast = useToast();
  const [stores, setStores] = useState<Store[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [rewriting, setRewriting] = useState(false);
  const [rewrite, setRewrite] = useState<CopyRewriteResult | null>(null);

  const load = useCallback(async () => {
    try {
      setStores(await api.listStores());
      setError(null);
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /**
   * Rewrites every store's copy with the user's own provider.
   *
   * With no key configured this is a dead end rather than an error to read, so
   * the user is taken to Settings — the only place that can fix it — instead of
   * being told to go there.
   */
  const rewriteAll = async () => {
    setRewriting(true);
    setError(null);
    try {
      const result = await api.rewriteCopy();
      setRewrite(result);
      toast.show(
        result.failed === 0
          ? `Rewrote copy for ${result.rewritten} ${result.rewritten === 1 ? "store" : "stores"}.`
          : `Rewrote ${result.rewritten}, ${result.failed} failed.`,
        result.failed === 0 ? "default" : "error",
      );
      await load();
    } catch (cause) {
      const failure = cause as ApiError;
      if (MISSING_KEY_CODES.includes(failure.code)) {
        toast.show(failure.message, "error");
        onNeedsAiKey();
        return;
      }
      setError(failure);
    } finally {
      setRewriting(false);
    }
  };

  const open = openStoreId
    ? (stores.find((store) => store.id === openStoreId) ?? null)
    : null;

  if (open) {
    return (
      <StoreDetail
        store={open}
        onBack={() => onOpenStore(null)}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <div className="stack">
      <div className="section-head">
        <h2>Stores</h2>
        <div className="section-head-actions">
          <span className="text-muted">{stores.length} generated</span>
          {stores.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void rewriteAll()}
              disabled={rewriting}
            >
              {rewriting ? "Rewriting…" : "Rewrite copy with AI"}
            </button>
          )}
        </div>
      </div>

      {error && <Banner title={error.message} />}

      {rewrite && rewrite.failed > 0 && (
        <Banner
          title={`${rewrite.failed} of ${rewrite.results.length} stores kept their existing copy.`}
        >
          <ul>
            {rewrite.results
              .filter((entry) => entry.status === "failed")
              .map((entry) => (
                <li key={entry.storeId}>
                  <strong>{entry.storeName}</strong> — {entry.message}
                </li>
              ))}
          </ul>
        </Banner>
      )}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : stores.length === 0 ? (
        <div className="empty">
          <div className="empty-title">No stores yet</div>
          Paste an AliExpress product link in the New store tab and you'll have a
          deployable storefront in about a minute.
        </div>
      ) : (
        <div className="store-list">
          {stores.map((store) => (
            <StoreRow
              key={store.id}
              store={store}
              onOpen={() => onOpenStore(store.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StoreRow({ store, onOpen }: { store: Store; onOpen: () => void }) {
  const image = store.product.images[0];

  return (
    <div className="store-row">
      {/* A bundled image is a project-relative path, which the app frame can't
          resolve — only remote URLs are previewable here. */}
      {image && /^https?:/.test(image.url) ? (
        <img className="grayscale" src={image.url} alt="" />
      ) : (
        <div
          style={{ width: 72, height: 72, background: "var(--color-neutral-200)" }}
          aria-hidden="true"
        />
      )}

      <div className="store-row-meta">
        <div className="store-row-name">{store.config.storeName}</div>
        <div className="store-row-sub">{store.product.title}</div>
        <div className="tag-row">
          <CheckoutTag store={store} />
          <span className="tag tag-neutral">{store.status}</span>
          {store.deployedUrl && <span className="tag tag-outline">live</span>}
          <span className="tag tag-neutral">
            {new Date(store.createdAt).toLocaleDateString()}
          </span>
        </div>
      </div>

      <button type="button" className="btn btn-secondary" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

export function CheckoutTag({ store }: { store: Store }) {
  const { checkout } = store.config;

  if (checkout.provider === "stripe") {
    return (
      <span className="tag tag-accent">
        Stripe {checkout.mode === "api" ? "checkout" : "payment links"}
      </span>
    );
  }
  if (checkout.provider === "waitlist") {
    return <span className="tag tag-outline">Waitlist</span>;
  }
  return <span className="tag tag-neutral">No checkout</span>;
}
