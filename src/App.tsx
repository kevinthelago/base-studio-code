import { useState, useEffect } from "react";
import { Titlebar } from "./components/chrome/Titlebar";
import { Rail } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";
import { Dialog } from "./components/Dialog";
import { useAppStore } from "./store";
import { useHotkeys } from "./hooks/useHotkeys";
import { ConsoleScreen } from "./screens/Console";
import { KnowledgeStoreScreen } from "./screens/KnowledgeStore";
import { GitHubScreen } from "./screens/github";
import { AutomationsScreen } from "./screens/automations";
import { SettingsScreen } from "./screens/settings";
import type { Tab } from "./components/chrome/Tabstrip";

// ── New-tab dialog ────────────────────────────────────────────────────────────

const LAYOUTS: string[] = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"];

interface NewTabDialogProps {
  onConfirm: (tab: Tab) => void;
  onDismiss: () => void;
}

function NewTabDialog({ onConfirm, onDismiss }: NewTabDialogProps) {
  const [name, setName] = useState("");
  const [layout, setLayout] = useState("2×2");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm({ name: name.trim() || "workspace", layout, state: "idle" });
  }

  return (
    <Dialog title="New tab" onDismiss={onDismiss} actions={
      <>
        <button className="btn" onClick={onDismiss}>cancel</button>
        <button className="btn primary" onClick={handleSubmit}>create</button>
      </>
    }>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          <label>Name</label>
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="workspace"
          />
        </div>
        <div className="field">
          <label>Layout</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {LAYOUTS.map((l) => {
              const [c, r] = l.split("×").map(Number);
              const active = l === layout;
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLayout(l)}
                  style={{
                    padding: "6px 10px", borderRadius: 5, cursor: "pointer",
                    fontFamily: "var(--mono)", fontSize: 11.5,
                    background: active ? "var(--bg-elev2)" : "var(--bg-elev)",
                    border: "1px solid " + (active ? "var(--accent)" : "var(--border-soft)"),
                    color: active ? "var(--accent)" : "var(--fg-muted)",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  }}
                >
                  {/* Mini grid preview */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${c}, 10px)`,
                    gridTemplateRows: `repeat(${r}, 7px)`,
                    gap: 2,
                  }}>
                    {Array.from({ length: c * r }).map((_, i) => (
                      <div key={i} style={{
                        borderRadius: 1,
                        background: active ? "var(--accent)" : "var(--border)",
                      }} />
                    ))}
                  </div>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();

  const {
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
    addTab, closeTab,
    githubConnected,
  } = useAppStore();

  const [confirmCloseIdx, setConfirmCloseIdx] = useState<number | null>(null);
  const [showNewTab, setShowNewTab] = useState(false);

  // Also handle ⌘T hotkey for new tab
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "t" && activeScreen === "console") {
        e.preventDefault();
        setShowNewTab(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeScreen]);

  function handleCloseRequest(idx: number) {
    const tab = tabs[idx];
    if (tab.state === "run" || tab.state === "on") {
      setConfirmCloseIdx(idx);
    } else {
      closeTab(idx);
    }
  }

  function confirmClose() {
    if (confirmCloseIdx !== null) closeTab(confirmCloseIdx);
    setConfirmCloseIdx(null);
  }

  const pendingTab = confirmCloseIdx !== null ? tabs[confirmCloseIdx] : null;
  const activeSessionCount = pendingTab
    ? /* placeholder until real session tracking */ 1
    : 0;

  const screen = (() => {
    switch (activeScreen) {
      case "console":    return <ConsoleScreen />;
      case "knowledge":  return <KnowledgeStoreScreen />;
      case "github":     return <GitHubScreen />;
      case "automation": return <AutomationsScreen />;
      case "settings":   return <SettingsScreen />;
      default:           return null;
    }
  })();

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments" />
      <div className="shell">
        <Rail active={activeScreen} onNavigate={setScreen} />
        <div className="main">
          {activeScreen === "console" && (
            <Tabstrip
              tabs={tabs}
              activeIdx={activeTabIdx}
              onSelect={setActiveTab}
              onClose={handleCloseRequest}
              onAdd={() => setShowNewTab(true)}
            />
          )}
          <div className="page">{screen}</div>
          <StatusBar extra={
            activeScreen === "console"    ? <span className="s">9 panes · 5 views · acme/payments</span>
            : activeScreen === "automation" ? <span className="s"><i className="warn" /> 4 schedules armed · next at 02:00</span>
            : activeScreen === "github" && !githubConnected ? <span className="s" style={{ color: "var(--fg-dim)" }}><i className="off" /> github · not connected</span>
            : undefined
          } />
        </div>
      </div>

      {/* Close-tab confirmation */}
      {confirmCloseIdx !== null && pendingTab && (
        <Dialog
          title={`Close "${pendingTab.name}"?`}
          danger
          onDismiss={() => setConfirmCloseIdx(null)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirmCloseIdx(null)}>cancel</button>
              <button
                className="btn"
                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                onClick={confirmClose}
              >
                close tab
              </button>
            </>
          }
        >
          {activeSessionCount === 1
            ? "1 active session is running in this tab and will be stopped."
            : `${activeSessionCount} active sessions are running in this tab and will be stopped.`}
          {" "}This cannot be undone.
        </Dialog>
      )}

      {/* New tab */}
      {showNewTab && (
        <NewTabDialog
          onConfirm={(tab) => { addTab(tab); setShowNewTab(false); }}
          onDismiss={() => setShowNewTab(false)}
        />
      )}
    </div>
  );
}
