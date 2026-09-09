import { useCallback, useEffect, useState } from "react";
import type { DeployProvider, Store } from "@repo/shared";
import { ApiError, api, type DeployInstructions } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { CodeBlock } from "../components/CodeBlock.js";
import { Field } from "../components/Field.js";
import { useToast } from "../components/Toast.js";

const PROVIDERS: DeployProvider[] = ["vercel", "netlify"];

/**
 * BYO hosting.
 *
 * We emit the command; the host's own CLI performs the upload. That is not a
 * limitation to apologise for — it is why the user's storefront traffic costs
 * them what their host charges and costs us nothing, and why their deploy token
 * never has to leave their machine.
 */
export function Deploy({
  store,
  onChanged,
}: {
  store: Store;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [provider, setProvider] = useState<DeployProvider>(
    store.config.deployTarget === "netlify" ? "netlify" : "vercel",
  );
  const [instructions, setInstructions] = useState<DeployInstructions | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [deployedUrl, setDeployedUrl] = useState(store.deployedUrl ?? "");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstructions(await api.deployInstructions(store.id, provider));
      setError(null);
    } catch (cause) {
      setInstructions(null);
      setError(cause as ApiError);
    }
  }, [store.id, provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const recordDeployed = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.recordDeployed(store.id, deployedUrl.trim());
      onChanged();
      toast.show("Live URL saved.");
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      <div className="section-head">
        <h3>Deploy to your own hosting</h3>
        <div className="seg">
          {PROVIDERS.map((option) => (
            <label className="seg-opt" key={option}>
              <input
                type="radio"
                name="deploy-provider"
                checked={provider === option}
                onChange={() => setProvider(option)}
              />
              {option}
            </label>
          ))}
        </div>
      </div>

      <p className="text-muted" style={{ margin: 0 }}>
        The store is a plain Astro project on your machine and deploys to your
        own account. We never serve storefront traffic, and your deploy token
        never leaves this machine.
      </p>

      {instructions && (
        <>
          <CodeBlock>
            {[
              `cd ${instructions.projectDir}`,
              "npm install",
              "npm run build",
              `${instructions.tokenEnvVar}=<your token> ${instructions.command}`,
            ].join("\n")}
          </CodeBlock>

          {!instructions.tokenPresent && (
            <Banner title={`No ${provider} token saved`}>
              Add one under Settings → Deploy tokens so you don't have to paste
              it each time, or substitute it into the command above yourself.
            </Banner>
          )}

          {instructions.needsStripeEnv && (
            <Banner title="Set your Stripe key on the host before going live">
              This store ships a checkout function that reads{" "}
              <span className="mono">STRIPE_SECRET_KEY</span> from your hosting
              environment. Until it's set, checkout returns a 503 and the store
              says checkout isn't configured. The key stays with your host — it
              is never written into the project and this app never needs it.
            </Banner>
          )}

          <Banner tone="neutral" items={instructions.notes} />
        </>
      )}

      <div className="subhead">Once it's live</div>

      <div className="row row-grow">
        <Field
          label="Live URL"
          htmlFor="deployed-url"
          hint="Recorded here so you can find the store later. Nothing is sent anywhere."
        >
          <input
            id="deployed-url"
            className="input"
            type="url"
            placeholder="https://my-store.vercel.app"
            value={deployedUrl}
            onChange={(event) => setDeployedUrl(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || deployedUrl.trim().length === 0}
          onClick={() => void recordDeployed()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
