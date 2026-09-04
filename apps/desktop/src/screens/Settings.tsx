import { useEffect, useState } from "react";
import type { SettingsView } from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { SecretField } from "../components/SecretField.js";

/**
 * BYOK settings.
 *
 * Every key here belongs to the user and is used from their machine only. The
 * copy says so explicitly — it's the product's differentiator, not a caveat.
 */
export function Settings() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setSettings((await api.getSettings()) as SettingsView);
      setError(null);
    } catch (cause) {
      setError(cause as ApiError);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSettings((await action()) as SettingsView);
      setNotice(message);
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const chooseBackupDir = async () => {
    const directory = await desktop.chooseDirectory();
    if (!directory) return;
    await run(
      () => api.setBackup(true, directory) as Promise<unknown>,
      "Backup folder saved.",
    );
  };

  if (!settings) {
    return error ? <Banner title={error.message} /> : <div className="spinner">Loading…</div>;
  }

  const isPremium = settings.profile.tier === "premium";

  return (
    <div className="stack">
      <div className="section-head">
        <h2>Settings</h2>
        <span className="tag tag-outline">{settings.profile.tier}</span>
      </div>

      {error && <Banner title={error.message}>{error.detail && <div className="mono">{error.detail}</div>}</Banner>}
      {notice && <Banner tone="neutral" title={notice} />}

      <Banner tone="neutral">
        Your keys stay on this machine, encrypted at rest, and are sent only to
        the service they belong to. We never proxy AI calls, never touch your
        payments, and never host your storefronts.
      </Banner>

      <hr className="hr" />

      <h3>Checkout</h3>
      <SecretField
        label="Stripe secret key"
        hint="Used once, from this machine, to create the Stripe payment link baked into each store. Never written into a generated store."
        placeholder="sk_live_… or sk_test_…"
        meta={settings.stripe}
        busy={busy}
        onSave={(value) =>
          void run(() => api.saveStripeKey(value), "Stripe key validated and saved.")
        }
        onClear={() =>
          void run(() => api.deleteSecret("stripe_secret_key"), "Stripe key removed.")
        }
      />

      <hr className="hr" />

      <h3>AI features</h3>
      <SecretField
        label="OpenRouter API key"
        hint="Powers the optional product-copy rewrite. Calls go straight from this machine to OpenRouter and are billed to your account."
        placeholder="sk-or-v1-…"
        meta={settings.openRouter}
        busy={busy}
        onSave={(value) =>
          void run(
            () => api.saveOpenRouterKey(value),
            "OpenRouter key validated and saved.",
          )
        }
        onClear={() =>
          void run(
            () => api.deleteSecret("openrouter_api_key"),
            "OpenRouter key removed.",
          )
        }
      />

      <hr className="hr" />

      <h3>Deploy tokens</h3>
      <div className="grid-2">
        <SecretField
          label="Vercel token"
          hint="Optional. Lets the deploy command run without pasting a token."
          placeholder="vercel token"
          meta={settings.deployTokens.vercel}
          busy={busy}
          onSave={(value) =>
            void run(
              () => api.saveDeployToken("vercel", value),
              "Vercel token saved.",
            )
          }
          onClear={() =>
            void run(
              () => api.deleteSecret("deploy_token_vercel"),
              "Vercel token removed.",
            )
          }
        />
        <SecretField
          label="Netlify token"
          hint="Optional. Lets the deploy command run without pasting a token."
          placeholder="netlify token"
          meta={settings.deployTokens.netlify}
          busy={busy}
          onSave={(value) =>
            void run(
              () => api.saveDeployToken("netlify", value),
              "Netlify token saved.",
            )
          }
          onClear={() =>
            void run(
              () => api.deleteSecret("deploy_token_netlify"),
              "Netlify token removed.",
            )
          }
        />
      </div>

      <hr className="hr" />

      <h3>Backups</h3>
      {isPremium ? (
        <div className="stack-tight">
          <p className="text-muted">
            Backups are written to a folder you choose on your own machine — or a
            cloud folder you already sync. Nothing is uploaded to us.
          </p>
          <div className="mono">{settings.backupDir ?? "No folder chosen"}</div>
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void chooseBackupDir()}
            >
              Choose folder
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !settings.backupDir}
              onClick={() =>
                void run(async () => {
                  await api.runBackup();
                  return api.getSettings();
                }, "Backup written.")
              }
            >
              Back up now
            </button>
          </div>
        </div>
      ) : (
        <Banner title="Backups are a premium feature">
          Your data lives in a local SQLite file either way — premium adds
          automated snapshots to a folder you pick.
        </Banner>
      )}
    </div>
  );
}
