import { useCallback, useEffect, useState } from "react";
import { desktop } from "./bridge.js";
import { ToastProvider } from "./components/Toast.js";
import { NewStore } from "./screens/NewStore.js";
import { Settings } from "./screens/Settings.js";
import { Stores } from "./screens/Stores.js";

type Tab = "new" | "stores" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "new", label: "New store" },
  { id: "stores", label: "Stores" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("new");
  const [reloadKey, setReloadKey] = useState(0);
  const [openStoreId, setOpenStoreId] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    void desktop
      .info()
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(""));
  }, []);

  // A freshly generated store should land you on it, not on a list you then
  // have to search — generating one is the whole point of the New store tab.
  const handleCreated = useCallback((storeId: string) => {
    setReloadKey((key) => key + 1);
    setOpenStoreId(storeId);
    setTab("stores");
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <nav className="sidebar">
          <div className="sidebar-brand">
            Store
            <br />
            Validator
          </div>

          <div className="sidebar-nav">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="sidebar-tab"
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => {
                  setTab(entry.id);
                  if (entry.id === "stores") setOpenStoreId(null);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="sidebar-foot">
            {version && <>v{version}</>}
            <br />
            Your keys, your hosting.
          </div>
        </nav>

        <main className="app-main">
          <div className="app-main-inner">
            {tab === "new" && <NewStore onCreated={handleCreated} />}
            {tab === "stores" && (
              <Stores
                reloadKey={reloadKey}
                openStoreId={openStoreId}
                onOpenStore={setOpenStoreId}
              />
            )}
            {tab === "settings" && <Settings />}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
