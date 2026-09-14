import { useEffect, useState } from "react";
import {
  AI_PROVIDERS,
  AI_PROVIDER_INFO,
  modelFor,
  type AiProvider,
  type SettingsView,
} from "@repo/shared";
import {
  ApiError,
  api,
  desktop,
  type AccountState,
  type LicenseStatus,
} from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { Field } from "../components/Field.js";
import { SecretField } from "../components/SecretField.js";
import { Backups } from "./Backups.js";
import { useToast } from "../components/Toast.js";

/**
 * BYOK settings.
 *
 * Every key here belongs to the user and is used from their machine only. The
 * copy says so explicitly — it's the product's differentiator, not a caveat.
 */
export function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [signinEmail, setSigninEmail] = useState("");
  const [signinCode, setSigninCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [nextSettings, nextLicense, nextAccount] = await Promise.all([
        api.getSettings(),
        api.license(),
        api.account(),
      ]);
      setSettings(nextSettings);
      setLicense(nextLicense);
      setAccount(nextAccount);
      setError(null);

      // Quietly bring the subscription up to date on open. Failures are
      // ignored on purpose: the cached entitlement is still valid offline, and
      // an error banner every time the network is flaky would be noise.
      void api
        .refreshAccount()
        .then(setAccount)
        .catch(() => undefined);
    } catch (cause) {
      setError(cause as ApiError);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Runs a settings mutation, showing its result once rather than per screen. */
  const run = async (action: () => Promise<SettingsView>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await action());
      toast.show(message);
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setBusy(false);
    }
  };


  if (!settings) {
    return error ? (
      <Banner title={error.message} />
    ) : (
      <div className="spinner">Loading…</div>
    );
  }

  const isPremium = (license?.tier ?? settings.profile.tier) === "premium";
  const provider = settings.ai.provider;
  const providerInfo = AI_PROVIDER_INFO[provider];

  return (
    <div className="stack">
      <div className="section-head">
        <h2>Settings</h2>
        <span className={isPremium ? "tag tag-accent" : "tag tag-outline"}>
          {license?.tier ?? settings.profile.tier}
        </span>
      </div>

      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      <Banner tone="neutral">
        Your keys stay on this machine, encrypted at rest, and are sent only to
        the service they belong to. We never proxy AI calls, never touch your
        payments, and never host your storefronts.
      </Banner>

      <hr className="hr" />

      <h3>Subscription</h3>

      {account?.staleReason && <Banner title={account.staleReason} />}

      {account?.signedIn ? (
        <div className="stack-tight">
          <p className="text-muted">
            Signed in as {account.email}.{" "}
            {account.tier === "premium"
              ? `Premium is active${
                  account.periodEnd
                    ? ` ${
                        account.status === "canceled" ? "until" : "and renews"
                      } ${new Date(account.periodEnd).toLocaleDateString()}`
                    : ""
                }.`
              : "No active subscription on this account."}
          </p>
          {account.status === "past_due" && (
            <Banner title="Your last payment didn't go through">
              Update your card with Stripe to keep premium. Nothing is switched
              off yet.
            </Banner>
          )}
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setAccount(await api.refreshAccount());
                  return api.getSettings();
                }, "Subscription checked.")
              }
            >
              Check subscription
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setAccount(await api.signOutAccount());
                  return api.getSettings();
                }, "Signed out on this device.")
              }
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-tight">
          <p className="text-muted">
            Free covers unlimited store generation, live preview, themes, bundled
            images and waitlist capture. Premium adds Stripe checkout on your
            generated stores and automated backups.
          </p>

          <Field
            label="Email"
            htmlFor="signin-email"
            hint="The address you subscribed with. We'll send a code — there's no password."
          >
            <input
              id="signin-email"
              className="input"
              type="email"
              autoComplete="email"
              value={signinEmail}
              onChange={(event) => setSigninEmail(event.target.value)}
            />
          </Field>

          {codeSent && (
            <Field
              label="Sign-in code"
              htmlFor="signin-code"
              hint="Six digits, from the email we just sent."
            >
              <input
                id="signin-code"
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={signinCode}
                onChange={(event) => setSigninCode(event.target.value)}
              />
            </Field>
          )}

          <div className="inline-actions">
            {!codeSent ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || signinEmail.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await api.requestSigninCode(signinEmail.trim());
                    setCodeSent(true);
                    return api.getSettings();
                  }, "Code sent. Check your email.")
                }
              >
                Send code
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || signinCode.trim().length === 0}
                  onClick={() =>
                    void run(async () => {
                      setAccount(
                        await api.verifySigninCode(
                          signinEmail.trim(),
                          signinCode.trim(),
                        ),
                      );
                      setSigninCode("");
                      setCodeSent(false);
                      return api.getSettings();
                    }, "Signed in.")
                  }
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setCodeSent(false)}
                >
                  Use a different email
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <hr className="hr" />

      <h3>AI</h3>
      <p className="text-muted">
        Optional, and used only where you ask for it — rewriting product copy and
        writing image alt text. Whichever provider you pick, the request goes
        from this machine straight to them on your own key and is billed to your
        account.
      </p>

      <Field
        label="Provider"
        htmlFor="ai-provider"
        hint="Switching provider doesn't touch either saved key."
      >
        <div className="seg" id="ai-provider">
          {AI_PROVIDERS.map((option) => (
            <label className="seg-opt" key={option}>
              <input
                type="radio"
                name="ai-provider"
                checked={provider === option}
                disabled={busy}
                onChange={() =>
                  void run(
                    () => api.setAiPreferences(option),
                    `AI provider set to ${AI_PROVIDER_INFO[option].label}.`,
                  )
                }
              />
              {AI_PROVIDER_INFO[option].label}
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Model"
        htmlFor="ai-model"
        hint={`Used for ${providerInfo.label} requests.`}
      >
        <select
          id="ai-model"
          className="input"
          disabled={busy}
          value={modelFor(settings.ai, provider)}
          onChange={(event) =>
            void run(
              () => api.setAiPreferences(provider, event.target.value),
              "Model saved.",
            )
          }
        >
          {providerInfo.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <AiKeyField
          provider="openrouter"
          settings={settings}
          busy={busy}
          onRun={run}
        />
        <AiKeyField provider="gemini" settings={settings} busy={busy} onRun={run} />
      </div>

      <hr className="hr" />

      <h3>Checkout</h3>
      <SecretField
        label="Stripe secret key"
        hint={
          isPremium
            ? "Used once, from this machine, to create Stripe payment links for static stores. Never written into a generated store. Stores deployed to Vercel or Netlify don't need it here at all — their own checkout function reads it from your host."
            : "Premium only. Free stores capture a waitlist instead of taking payment."
        }
        placeholder="sk_live_… or sk_test_…"
        meta={settings.stripe}
        busy={busy}
        onSave={(value) =>
          void run(
            () => api.saveStripeKey(value),
            "Stripe key validated and saved.",
          )
        }
        onClear={() =>
          void run(
            () => api.deleteSecret("stripe_secret_key"),
            "Stripe key removed.",
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
        <Backups settings={settings} busy={busy} onRun={run} />
      ) : (
        <Banner title="Backups are a premium feature">
          Your data lives in a local SQLite file either way. Premium adds
          automated snapshots to a folder you pick, and optional off-site
          storage that's encrypted on this machine before it's uploaded — we
          hold it and can't read it.
        </Banner>
      )}
    </div>
  );
}

function AiKeyField({
  provider,
  settings,
  busy,
  onRun,
}: {
  provider: AiProvider;
  settings: SettingsView;
  busy: boolean;
  onRun: (action: () => Promise<SettingsView>, message: string) => Promise<void>;
}) {
  const info = AI_PROVIDER_INFO[provider];
  const meta = provider === "gemini" ? settings.gemini : settings.openRouter;
  const inUse = settings.ai.provider === provider;

  return (
    <div className="stack-tight">
      <SecretField
        label={`${info.label} API key`}
        hint={
          inUse
            ? "Currently in use for AI features. Validated when you save it."
            : "Saved but not currently selected above."
        }
        placeholder={info.keyPlaceholder}
        meta={meta}
        busy={busy}
        onSave={(value) =>
          void onRun(
            () => api.saveAiKey(provider, value),
            `${info.label} key validated and saved.`,
          )
        }
        onClear={() =>
          void onRun(
            () =>
              api.deleteSecret(
                provider === "gemini" ? "gemini_api_key" : "openrouter_api_key",
              ),
            `${info.label} key removed.`,
          )
        }
      />
      <button
        type="button"
        className="btn btn-ghost"
        style={{ paddingLeft: 0 }}
        onClick={() => void desktop.openExternal(info.keyUrl)}
      >
        Get a key →
      </button>
    </div>
  );
}
