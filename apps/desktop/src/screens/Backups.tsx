import { useCallback, useEffect, useState } from "react";
import type {
  BackupDestination,
  BackupList,
  SettingsView,
} from "@repo/shared";
import { ApiError, api, desktop } from "../bridge.js";
import { Banner } from "../components/Banner.js";
import { Field } from "../components/Field.js";
import { useToast } from "../components/Toast.js";

const DESTINATIONS: { id: BackupDestination; label: string; hint: string }[] = [
  {
    id: "local",
    label: "A folder I pick",
    hint: "Your own disk, or a cloud folder you already sync. Nothing is uploaded to us.",
  },
  {
    id: "cloud",
    label: "Our hosted storage",
    hint: "Encrypted on this machine before it's uploaded. We store it and cannot read it.",
  },
  {
    id: "both",
    label: "Both",
    hint: "Recommended. A hosted copy is only a backup if the local one can also fail.",
  },
];

/**
 * Premium backups.
 *
 * Two destinations, and the copy is explicit about which one costs whom what.
 * Hosted backup is the one place we store user data, and the only reason that
 * is acceptable is that it is sealed here before it leaves — so the recovery
 * key gets prominent, slightly alarming treatment. Losing it means losing the
 * hosted backups, and pretending otherwise would be dishonest.
 */
export function Backups({
  settings,
  busy,
  onRun,
}: {
  settings: SettingsView;
  busy: boolean;
  onRun: (action: () => Promise<SettingsView>, message: string) => Promise<void>;
}) {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [working, setWorking] = useState(false);
  const [cloud, setCloud] = useState<BackupList | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [adopting, setAdopting] = useState("");
  const [restored, setRestored] = useState<string | null>(null);

  const usesCloud =
    settings.backupDestination === "cloud" || settings.backupDestination === "both";

  const loadCloud = useCallback(async () => {
    if (!usesCloud) {
      setCloud(null);
      return;
    }
    try {
      setCloud(await api.cloudBackups());
      setError(null);
    } catch (cause) {
      setCloud(null);
      setError(cause as ApiError);
    }
  }, [usesCloud]);

  useEffect(() => {
    void loadCloud();
  }, [loadCloud]);

  const guard = async (run: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause as ApiError);
    } finally {
      setWorking(false);
    }
  };

  const chooseDir = async () => {
    const directory = await desktop.chooseDirectory();
    if (!directory) return;
    await onRun(
      () => api.setBackup(true, directory, settings.backupDestination),
      "Backup folder saved.",
    );
  };

  const backUpNow = () =>
    guard(async () => {
      const result = await api.runBackup();
      await loadCloud();

      if (result.failures.length > 0) {
        toast.show(result.failures[0]!.message, "error");
      } else {
        toast.show(
          result.cloud && result.local
            ? "Backed up locally and to the cloud."
            : result.cloud
              ? "Uploaded an encrypted backup."
              : "Backup written.",
        );
      }
    });

  return (
    <div className="stack">
      {error && (
        <Banner title={error.message}>
          {error.detail && <div className="mono">{error.detail}</div>}
        </Banner>
      )}

      <Field label="Where backups go" htmlFor="backup-destination">
        <div className="seg" id="backup-destination">
          {DESTINATIONS.map((option) => (
            <label className="seg-opt" key={option.id}>
              <input
                type="radio"
                name="backup-destination"
                checked={settings.backupDestination === option.id}
                disabled={busy || working}
                onChange={() =>
                  void onRun(
                    () => api.setBackup(true, settings.backupDir, option.id),
                    `Backups now go to ${option.label.toLowerCase()}.`,
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </Field>

      <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
        {DESTINATIONS.find((d) => d.id === settings.backupDestination)?.hint}
      </p>

      {(settings.backupDestination === "local" ||
        settings.backupDestination === "both") && (
        <div className="stack-tight">
          <div className="subhead">Local folder</div>
          <div className="mono">{settings.backupDir ?? "No folder chosen"}</div>
          <div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || working}
              onClick={() => void chooseDir()}
            >
              Choose folder
            </button>
          </div>
        </div>
      )}

      {usesCloud && (
        <>
          <div className="subhead">Recovery key</div>
          <Banner tone="neutral">
            Your backups are encrypted on this machine before they're uploaded,
            with a key we never receive — so we genuinely cannot read them, and
            neither can anyone who breaches us. The flip side is that{" "}
            <strong>
              if you lose this key and this machine, the backups are gone for
              good.
            </strong>{" "}
            Save it somewhere that isn't this computer.
          </Banner>

          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || working}
              onClick={() =>
                void guard(async () => {
                  setRecoveryKey((await api.recoveryKey()).key);
                })
              }
            >
              {recoveryKey ? "Shown below" : "Show my recovery key"}
            </button>
            {recoveryKey && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(recoveryKey)
                    .then(() => toast.show("Recovery key copied."))
                    .catch(() => toast.show("Couldn't copy it.", "error"));
                }}
              >
                Copy
              </button>
            )}
          </div>

          {recoveryKey && <pre className="code-block">{recoveryKey}</pre>}

          <Field
            label="Restoring on a new machine?"
            htmlFor="adopt-key"
            hint="Paste the recovery key from your old machine. Without it, backups made there can't be opened here."
          >
            <input
              id="adopt-key"
              className="input mono"
              value={adopting}
              spellCheck={false}
              autoComplete="off"
              placeholder="ABCDEF-GHJKMN-…"
              onChange={(event) => setAdopting(event.target.value)}
            />
          </Field>
          <div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || working || adopting.trim().length === 0}
              onClick={() =>
                void guard(async () => {
                  await api.setRecoveryKey(adopting.trim());
                  setAdopting("");
                  setRecoveryKey(null);
                  await loadCloud();
                  toast.show("Recovery key adopted.");
                })
              }
            >
              Use this key
            </button>
          </div>
        </>
      )}

      <div className="inline-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            working ||
            (settings.backupDestination === "local" && !settings.backupDir)
          }
          onClick={() => void backUpNow()}
        >
          {working ? "Backing up…" : "Back up now"}
        </button>
      </div>

      {usesCloud && cloud && (
        <>
          <div className="subhead">
            Cloud backups — {cloud.backups.length} of {cloud.quota.maxCount},{" "}
            {formatBytes(cloud.quota.usedBytes)} of{" "}
            {formatBytes(cloud.quota.limitBytes)}
          </div>

          {cloud.backups.length === 0 ? (
            <div className="text-muted" style={{ fontSize: 13 }}>
              Nothing uploaded yet.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cloud.backups.map((backup) => (
                  <tr key={backup.id}>
                    <td>{new Date(backup.createdAt).toLocaleString()}</td>
                    <td>{formatBytes(backup.sizeBytes)}</td>
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={working}
                          onClick={() =>
                            void guard(async () => {
                              const result = await api.restoreCloudBackup(backup.id);
                              setRestored(result.path);
                            })
                          }
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={working}
                          onClick={() =>
                            void guard(async () => {
                              setCloud(await api.deleteCloudBackup(backup.id));
                              toast.show("Backup deleted.");
                            })
                          }
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

          <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
            The oldest is removed automatically once you reach{" "}
            {cloud.quota.maxCount}. Uploads over{" "}
            {formatBytes(cloud.quota.maxUploadBytes)} are refused — back those up
            to a local folder instead.
          </p>
        </>
      )}

      {restored && (
        <Banner tone="success" title="Restore staged — restart to finish">
          <p style={{ margin: "4px 0 0" }}>
            The backup has been decrypted and written to{" "}
            <span className="mono">{restored}</span>. It's applied the next time
            the app starts, before anything opens the database — swapping it out
            from under a running app is how data gets corrupted. Your current
            database is kept alongside it, not deleted.
          </p>
        </Banner>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
