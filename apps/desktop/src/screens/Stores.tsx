import { useEffect, useState } from "react";
import type { Store } from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";

interface DeployInstructions {
  provider: string;
  projectDir: string;
  command: string;
  tokenEnvVar: string;
  tokenPresent: boolean;
  notes: string[];
}

/** Generated stores, and how to get each one online. */
export function Stores({ reloadKey }: { reloadKey: number }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [instructions, setInstructions] = useState<DeployInstructions | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setStores((await api.listStores()) as Store[]);
      setError(null);
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [reloadKey]);

  const showDeploy = async (id: string, provider: string) => {
    setSelected(id);
    try {
      setInstructions((await api.deployInstructions(id, provider)) as DeployInstructions);
      setError(null);
    } catch (cause) {
      setInstructions(null);
      setError(cause as ApiError);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteStore(id);
      await load();
    } catch (cause) {
      setError(cause as ApiError);
    }
  };

  return (
    <div className="stack">
      <div className="section-head">
        <h2>Stores</h2>
        <span className="text-muted">
          {stores.length} generated
        </span>
      </div>

      {error && <Banner title={error.message} />}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : stores.length === 0 ? (
        <div className="empty">
          No stores yet. Generate one from the New store tab.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Store</th>
              <th>Product</th>
              <th>Checkout</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => (
              <tr key={store.id}>
                <td>
                  <strong>{store.config.storeName}</strong>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {new Date(store.createdAt).toLocaleDateString()}
                  </div>
                </td>
                <td style={{ maxWidth: 260 }}>{store.product.title}</td>
                <td>
                  {store.config.checkout.paymentLinkUrl ? (
                    <span className="tag tag-accent">Stripe</span>
                  ) : (
                    <span className="tag tag-neutral">None</span>
                  )}
                </td>
                <td>
                  <span className="tag tag-outline">{store.status}</span>
                </td>
                <td>
                  <div className="inline-actions">
                    {store.outputDir && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void desktop.openPath(store.outputDir as string)}
                      >
                        Folder
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void showDeploy(store.id, "vercel")}
                    >
                      Deploy
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void remove(store.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {instructions && selected && (
        <div className="stack-tight">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>Deploy to your own hosting</h3>
            <div className="seg">
              {["vercel", "netlify"].map((provider) => (
                <label className="seg-opt" key={provider}>
                  <input
                    type="radio"
                    name="deploy-provider"
                    checked={instructions.provider === provider}
                    onChange={() => void showDeploy(selected, provider)}
                  />
                  {provider}
                </label>
              ))}
            </div>
          </div>

          <p className="text-muted">
            The store is a plain Astro project on your machine and deploys to
            your own account. We never host storefront traffic.
          </p>

          <div className="code-block">
            {`cd ${instructions.projectDir}\nnpm install\nnpm run build\n${instructions.tokenEnvVar}=<your token> ${instructions.command}`}
          </div>

          {!instructions.tokenPresent && (
            <Banner title="No deploy token saved">
              Add a {instructions.provider} token in Settings, or paste it into the
              command above yourself.
            </Banner>
          )}

          <Banner tone="neutral" items={instructions.notes} />
        </div>
      )}
    </div>
  );
}
