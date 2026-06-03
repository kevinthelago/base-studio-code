import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LayoutGrid } from "lucide-react";
import { Titlebar } from "./components/chrome/Titlebar";
import { Rail } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";
import { Dialog } from "./components/Dialog";
import { useAppStore } from "./store";
import { useHotkeys } from "./hooks/useHotkeys";
import { useScheduler } from "./hooks/useScheduler";
import { startPerfMonitor, recordStoreWrite } from "./lib/perf";
import { log } from "./lib/log";
import { ConsoleScreen } from "./screens/Console";
import { KnowledgeStoreScreen } from "./screens/KnowledgeStore";
import { GitHubScreen } from "./screens/github";
import { AutomationsScreen } from "./screens/automations";
import { ExtensionsScreen } from "./screens/extensions";
import { SettingsScreen } from "./screens/settings";
import { ProjectsScreen } from "./screens/projects";
import { SkillsScreen } from "./screens/skills";
import { AgentsScreen } from "./screens/agents";
import { SKILL_KPIS } from "./data/skills";
import type { Tab } from "./components/chrome/Tabstrip";
import { SuperUserAchievement } from "./components/SuperUserAchievement";

// ── New-tab dialog ────────────────────────────────────────────────────────────

const LAYOUTS: string[] = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"];

function nextTabName(tabs: Tab[]): string {
  const nums = tabs
    .map(t => t.name.match(/^tab-(\d+)$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `tab-${nums.length === 0 ? 1 : Math.max(...nums) + 1}`;
}

interface NewTabDialogProps {
  onConfirm: (layout: string) => void;
  onDismiss: () => void;
}

function NewTabDialog({ onConfirm, onDismiss }: NewTabDialogProps) {
  const [layout, setLayout] = useState("2×2");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(layout);
  }

  return (
    <Dialog title="New workspace" onDismiss={onDismiss} actions={
      <>
        <button className="btn" onClick={onDismiss}>cancel</button>
        <button className="btn primary" onClick={handleSubmit}>create</button>
      </>
    }>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
                  autoFocus={l === layout}
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

function ConsoleEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 16,
    }}>
      <LayoutGrid size={40} style={{ color: "var(--fg-dim)", opacity: 0.4 }} />
      <div style={{ textAlign: "center", lineHeight: 1.6 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)", marginBottom: 4 }}>
          No workspaces
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Create a workspace to start running agents in parallel.
        </div>
      </div>
      <button className="btn primary" onClick={onNew} style={{ marginTop: 4 }}>
        New workspace
      </button>
    </div>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();
  useScheduler();

  const {
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
    addTab, closeTab, renameTab, setTabLayout, moveTab,
    focusedAgentName,
    activeRepoName,
    automationsTab,
    settingsSection,
    projectsView, activeProjectName, projectsBoardTab,
    setBscBaseDir,
    hasHydrated,
  } = useAppStore();

  // Mount the Knowledge Store (and spawn its claude session) lazily on first
  // visit, then keep it mounted so the PTY survives navigation. Avoids launching
  // a background claude at app startup for a screen that may never be opened.
  const knowledgeEverShown = useRef(false);
  if (activeScreen === "knowledge") knowledgeEverShown.current = true;

  // Fetch the app-managed base directory once so the rest of the UI can
  // compute repo local paths deterministically without round-tripping Rust.
  useEffect(() => {
    invoke<string>("get_base_dir")
      .then(setBscBaseDir)
      .catch((e) => log.error(`get_base_dir failed: ${e}`));
    // Watch the main thread for jank (logs `[perf] main thread blocked …`).
    startPerfMonitor();
    // Diagnostic: count how often each store key changes, so a re-render loop
    // reveals which key drives it (shown as `store <key>×N` in the perf line).
    const unsub = useAppStore.subscribe((state, prev) => {
      const s = state as unknown as Record<string, unknown>;
      const p = prev as unknown as Record<string, unknown>;
      for (const k in s) {
        if (s[k] !== p[k]) recordStoreWrite(k);
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleWorkspace = (() => {
    const parts: string[] = [];
    switch (activeScreen) {
      case "console":
        parts.push("Console");
        if (tabs[activeTabIdx]?.name) parts.push(tabs[activeTabIdx].name);
        if (focusedAgentName) parts.push(focusedAgentName);
        break;
      case "knowledge":
        parts.push("Knowledge Store");
        break;
      case "github":
        parts.push("GitHub");
        if (activeRepoName) parts.push(activeRepoName);
        break;
      case "automation":
        parts.push("Automations");
        parts.push(automationsTab);
        break;
      case "extensions":
        parts.push("Extensions");
        break;
      case "projects":
        parts.push("Projects");
        if (projectsView === "planning") {
          parts.push("planning");
        } else if (projectsView === "board" && activeProjectName) {
          parts.push(activeProjectName);
          parts.push(projectsBoardTab);
        }
        break;
      case "skills":
        parts.push("Skills");
        break;
      case "agents":
        parts.push("Agents");
        break;
      case "settings":
        parts.push("Settings");
        parts.push(settingsSection);
        break;
      default:
        parts.push(activeScreen);
    }
    return parts.filter(Boolean).join(" — ");
  })();

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

  function killTabPtys(tabIdx: number, layout: string) {
    const [c, r] = layout.split("×").map(Number);
    for (let i = 0; i < c * r; i++) {
      invoke("pty_kill", { paneId: `t${tabIdx}p${i}` }).catch(console.error);
    }
  }

  async function handleLayoutChange(tabIdx: number, layout: string) {
    const tab = tabs[tabIdx];
    const [oldCols, oldRows] = tab.layout.split("×").map(Number);
    const [newCols, newRows] = layout.split("×").map(Number);
    const oldCount = oldCols * oldRows;
    const newCount = newCols * newRows;
    // Kill PTY sessions for panes that will no longer exist
    if (newCount < oldCount) {
      for (let i = newCount; i < oldCount; i++) {
        invoke("pty_kill", { paneId: `t${tabIdx}p${i}` }).catch(console.error);
      }
    }
    setTabLayout(tabIdx, layout);
  }

  function handleCloseRequest(idx: number) {
    const tab = tabs[idx];
    if (tab.state === "run" || tab.state === "on") {
      setConfirmCloseIdx(idx);
    } else {
      killTabPtys(idx, tab.layout);
      closeTab(idx);
    }
  }

  function confirmClose() {
    if (confirmCloseIdx !== null) {
      killTabPtys(confirmCloseIdx, tabs[confirmCloseIdx].layout);
      closeTab(confirmCloseIdx);
    }
    setConfirmCloseIdx(null);
  }

  const pendingTab = confirmCloseIdx !== null ? tabs[confirmCloseIdx] : null;
  const activeSessionCount = pendingTab
    ? /* placeholder until real session tracking */ 1
    : 0;

  // Hold the first paint until the async-persisted state has hydrated, so screens
  // don't flash from store defaults (e.g. GitHub "not connected" → connected) on
  // load. Hydration is a fast local read — a brief blank-canvas frame, not a wait.
  if (!hasHydrated) return <div className="app" />;

  return (
    <div className="app">
      <SuperUserAchievement />
      <Titlebar workspace={titleWorkspace} />
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
              onRename={renameTab}
              onChangeLayout={handleLayoutChange}
              onReorder={moveTab}
            />
          )}
          {/* ConsoleScreen stays mounted across all screen navigations so xterm
              instances and PTY sessions are never torn down unnecessarily. CSS
              hides it when another screen is active. */}
          <div className="page">
          {tabs.length > 0 && (
            <div style={{
              display: activeScreen === "console" ? "flex" : "none",
              flex: 1, flexDirection: "column", minHeight: 0,
            }}>
              <ConsoleScreen />
            </div>
          )}
          {activeScreen === "console" && tabs.length === 0 && (
            <ConsoleEmptyState onNew={() => setShowNewTab(true)} />
          )}
          {/* KnowledgeStore and Projects stay mounted so local state and PTY
              sessions survive screen switches. CSS hides them when inactive.
              KnowledgeStore is mounted lazily on first visit (see above) so its
              claude session isn't spawned at startup. */}
          {knowledgeEverShown.current && (
            <div style={{ display: activeScreen === "knowledge" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
              <KnowledgeStoreScreen />
            </div>
          )}
          <div style={{ display: activeScreen === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
            <ProjectsScreen />
          </div>
          {activeScreen === "github"     && <GitHubScreen />}
          {activeScreen === "automation" && <AutomationsScreen />}
          {activeScreen === "extensions" && <ExtensionsScreen />}
          {activeScreen === "skills"     && <SkillsScreen />}
          {activeScreen === "agents"     && <AgentsScreen />}
          {activeScreen === "settings"   && <SettingsScreen />}
          </div>
          <StatusBar extra={
            activeScreen === "automation"
              ? <span className="s"><i className="warn" /> 4 schedules armed · next at 02:00</span>
            : activeScreen === "skills"
              ? <>
                  <span className="s"><i /> {SKILL_KPIS.total} skills loaded</span>
                  <span className="s"><i /> {SKILL_KPIS.invToday} invocations today</span>
                  <span className="s"><i className="warn" /> bump-dep-safely 78%</span>
                </>
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
          onConfirm={(layout) => { addTab({ name: nextTabName(tabs), layout, state: "idle" }); setShowNewTab(false); }}
          onDismiss={() => setShowNewTab(false)}
        />
      )}
    </div>
  );
}
