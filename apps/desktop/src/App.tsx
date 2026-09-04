import { useEffect, useState } from "react";
import { desktop } from "./bridge.js";
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
  const [version, setVersion] = useState("");

  useEffect(() => {
    void desktop
      .info()
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(""));
  }, []);

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">Store Validator</span>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="nav-tab"
            aria-current={tab === entry.id ? "page" : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        {version && <span className="text-muted" style={{ fontSize: 12 }}>v{version}</span>}
      </nav>

      <main className="app-main">
        {tab === "new" && (
          <NewStore
            onCreated={() => {
              setReloadKey((key) => key + 1);
            }}
          />
        )}
        {tab === "stores" && <Stores reloadKey={reloadKey} />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}
