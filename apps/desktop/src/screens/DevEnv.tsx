import { useCallback, useEffect, useRef, useState } from "react";
import {
  STORE_NODE_VERSION,
  type DevEnvProgress,
  type DevEnvStatus,
  type Store,
} from "@repo/shared";
import { ApiError, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { CodeBlock } from "../components/CodeBlock.js";
import { useToast } from "../components/Toast.js";

/**
 * Turning a generated store into a project the user can actually work in.
 *
 * The store the preview runs is not one anyone can open: its `node_modules` is
 * a symlink to our shared Astro runtime, which resolves only on this machine
 * and only while this app is installed. Everything the README tells the user to
 * do next — open it in an editor, commit it, copy it to a build machine —
 * assumes a real install. This screen makes that one button.
 */
export function DevEnv({ store }: { store: Store }) {
  const toast = useToast();
  const [status, setStatus] = useState<DevEnvStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const projectDir = store.outputDir;

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    try {
      setStatus(await desktop.devEnvStatus(store.id, projectDir));
      setError(null);
    } catch (cause) {
      setError(cause as ApiError);
    }
  }, [store.id, projectDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      desktop.onDevEnvProgress((event: DevEnvProgress) => {
        if (event.storeId !== store.id) return;
        setLog((lines) => [...lines, event.line].slice(-400));
      }),
    [store.id],
  );

  // Follow the tail while npm talks, the way a terminal would.
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);

  if (!projectDir) {
    return (
      <Banner title="This store hasn't been generated to disk yet">
        Rebuild it from the header above and its files will appear.
      </Banner>
    );
  }

  const install = async () => {
    setInstalling(true);
    setError(null);
    setLog([]);
    try {
      const result = await desktop.devEnvInstall(store.id, projectDir);
      setStatus(result.status);
      toast.show(
        result.packageCount
          ? `Installed ${result.packageCount} packages.`
          : "Dev environment ready.",
      );
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setInstalling(false);
    }
  };

  const npmMissing = status !== null && status.toolchain.npmPath === null;

  return (
    <div className="stack">
      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      <div className="subhead">This project</div>

      {status === null ? (
        <div className="spinner">Checking…</div>
      ) : (
        <dl className="kv">
          <dt>Folder</dt>
          <dd className="mono">{status.projectDir}</dd>

          <dt>Dependencies</dt>
          <dd>
            <DevEnvKindLabel status={status} />
          </dd>

          <dt>Node on this machine</dt>
          <dd>
            <span
              className={
                status.toolchain.nodeVersion
                  ? "status-dot status-dot-ok"
                  : "status-dot status-dot-warn"
              }
            />
            {status.toolchain.nodeVersion ?? "not found"}
            {status.toolchain.nodeVersion && (
              <span className="text-muted"> · store needs {STORE_NODE_VERSION}+</span>
            )}
          </dd>

          {status.needsStripeEnv && (
            <>
              <dt>Local .env</dt>
              <dd>
                <span
                  className={
                    status.envFilePresent
                      ? "status-dot status-dot-ok"
                      : "status-dot status-dot-warn"
                  }
                />
                {status.envFilePresent
                  ? "present"
                  : "not created — copy .env.example to .env"}
              </dd>
            </>
          )}
        </dl>
      )}

      {status?.kind === "linked" && (
        <Banner title="These dependencies won't travel with the folder">
          The preview borrowed a shared copy of Astro so it could start without
          installing anything. That link only works on this machine, inside this
          app. Set the dev environment up to replace it with a real install you
          own.
        </Banner>
      )}

      {npmMissing && (
        <Banner title="Node.js isn't installed on this machine">
          Install Node {STORE_NODE_VERSION} or newer from nodejs.org, then come
          back — or run the commands below yourself anywhere you do have it. The
          generated store is a plain Astro project; nothing about it needs this
          app.
        </Banner>
      )}

      <div className="inline-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={installing || npmMissing || status === null}
          onClick={() => void install()}
        >
          {installing
            ? "Installing…"
            : status?.kind === "installed"
              ? "Reinstall dependencies"
              : "Set up dev environment"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void desktop.openPath(projectDir)}
        >
          Open folder
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={installing}
          onClick={() => void refresh()}
        >
          Recheck
        </button>
      </div>

      {(installing || log.length > 0) && (
        <div className="log" ref={logRef} aria-live="polite">
          {log.map((line, index) => (
            <div
              key={`${index}-${line}`}
              className={/npm (error|ERR!)/.test(line) ? "log-line-error" : undefined}
            >
              {line}
            </div>
          ))}
          {installing && <div>…</div>}
        </div>
      )}

      <div className="subhead">Work on it yourself</div>

      <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
        This is an ordinary Astro project. Open it in your editor and run it the
        way you'd run any other — nothing here depends on this app.
      </p>

      <CodeBlock>{`cd ${projectDir}\nnpm install\nnpm run dev`}</CodeBlock>

      <dl className="kv">
        <dt className="mono">src/data/store.json</dt>
        <dd>All product and store data. Edit copy, prices and images here.</dd>

        <dt className="mono">src/styles/theme.css</dt>
        <dd>Theme tokens — accent colour, fonts, preset.</dd>

        <dt className="mono">src/pages/index.astro</dt>
        <dd>The product page.</dd>

        {status?.needsStripeEnv && (
          <>
            <dt className="mono">src/pages/api/checkout.ts</dt>
            <dd>
              The checkout endpoint. Runs on your host and reads{" "}
              <span className="mono">STRIPE_SECRET_KEY</span> from its
              environment — the key is never written into the project.
            </dd>
          </>
        )}

        <dt className="mono">DEVELOPMENT.md</dt>
        <dd>The same notes, kept inside the project itself.</dd>
      </dl>
    </div>
  );
}

function DevEnvKindLabel({ status }: { status: DevEnvStatus }) {
  if (status.kind === "installed") {
    return (
      <>
        <span className="status-dot status-dot-ok" />
        installed
        {status.packageCount !== null && (
          <span className="text-muted"> · {status.packageCount} packages</span>
        )}
      </>
    );
  }
  if (status.kind === "linked") {
    return (
      <>
        <span className="status-dot status-dot-warn" />
        shared preview runtime (not portable)
      </>
    );
  }
  return (
    <>
      <span className="status-dot" />
      not installed
    </>
  );
}
