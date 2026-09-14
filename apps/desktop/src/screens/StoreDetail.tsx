import { useState } from "react";
import type { Store } from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { useToast } from "../components/Toast.js";
import { Deploy } from "./Deploy.js";
import { DevEnv } from "./DevEnv.js";
import { Preview } from "./Preview.js";
import { CheckoutTag } from "./Stores.js";

type DetailTab = "preview" | "dev" | "deploy";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "preview", label: "Preview & theme" },
  { id: "dev", label: "Dev environment" },
  { id: "deploy", label: "Deploy" },
];

/**
 * Everything you can do with one generated store.
 *
 * The three tabs are the three things that happen after generation, in the
 * order they happen: look at it, work on it, ship it.
 */
export function StoreDetail({
  store,
  onBack,
  onChanged,
}: {
  store: Store;
  onBack: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<DetailTab>("preview");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteStore(store.id);
      toast.show(`${store.config.storeName} removed from the list.`);
      onChanged();
      onBack();
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.regenerateStore(store.id);
      onChanged();
      toast.show(
        result.warnings.length > 0
          ? `Rebuilt with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
          : "Store rebuilt from its current settings.",
      );
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="section-head">
        <div>
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            ← All stores
          </button>
          <h2 style={{ marginTop: 4 }}>{store.config.storeName}</h2>
          <div className="tag-row" style={{ marginTop: 6 }}>
            <CheckoutTag store={store} />
            <span className="tag tag-neutral">{store.status}</span>
            <span className="tag tag-neutral">{store.config.deployTarget}</span>
          </div>
        </div>

        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void regenerate()}
          >
            {busy ? "Working…" : "Rebuild files"}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void remove()}
              >
                Really remove
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingDelete(true)}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {confirmingDelete && (
        <Banner tone="neutral">
          This removes the store from this list only. The generated project stays
          on your disk at <span className="mono">{store.outputDir}</span> — those
          are your files, not ours to delete.
        </Banner>
      )}

      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      {store.deployedUrl && (
        <Banner tone="success" title="This store is live">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ paddingLeft: 0 }}
            onClick={() => void desktop.openExternal(store.deployedUrl as string)}
          >
            {store.deployedUrl}
          </button>
        </Banner>
      )}

      <div className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            aria-current={tab === entry.id ? "page" : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "preview" && <Preview store={store} onChanged={onChanged} />}
      {tab === "dev" && <DevEnv store={store} />}
      {tab === "deploy" && <Deploy store={store} onChanged={onChanged} />}
    </div>
  );
}
