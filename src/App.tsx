import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { markBoot, logStartupTrace } from "./lib/core/startupTrace";
import { invoke } from "@tauri-apps/api/core";
import { LayoutGrid } from "lucide-react";
import { Titlebar } from "./components/chrome/Titlebar";
import { Rail } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";
import { Dialog } from "./components/Dialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppStore } from "./store";
import { useHotkeys } from "./hooks/useHotkeys";
import { useScheduler } from "./hooks/useScheduler";
import { useTunnelSync } from "./hooks/useTunnelSync";
import { startPerfMonitor, recordStoreWrite } from "./lib/core/perf";
import { log } from "./lib/core/log";
import { ConsoleScreen } from "./screens/Console";
import { paneIdFor } from "./lib/console/paneIdentity";
import { AutomationsStatus } from "./screens/automations/AutomationsStatus";
import { SkillsStatus } from "./screens/skills/SkillsStatus";
import type { Tab } from "./components/chrome/Tabstrip";
import { SuperUserAchievement } from "./components/SuperUserAchievement";
import { CrashRecoveryBanner } from "./components/CrashRecoveryBanner";
import { QuarantineBanner } from "./components/QuarantineBanner";
import { useWarden } from "./lib/fleet/useWarden";
import { useWorkerAutoEnd } from "./lib/fleet/useWorkerAutoEnd";
import { useTunnelAutomations } from "./lib/tunnel/useTunnelAutomations";
import { useTunnelCoordControl } from "./lib/tunnel/useTunnelCoordControl";
import { openDetachedTab, detachedTabId, detachedSection } from "./lib/console/detachWindow";
import { accentVars } from "./lib/settings/appearance";

// Lazy-loaded screens (#perf): only the Console is needed at boot. Each other screen's chunk
// loads on first navigation, keeping the heavy module graph (esp. the planner) off the cold
// startup path — both the dev transform and the production bundle.
const GitHubScreen      = lazy(() => import("./screens/github").then((m) => ({ default: m.GitHubScreen })));
const AutomationsScreen = lazy(() => import("./screens/automations").then((m) => ({ default: m.AutomationsScreen })));
const McpScreen         = lazy(() => import("./screens/mcp").then((m) => ({ default: m.McpScreen })));
const SettingsScreen    = lazy(() => import("./screens/settings").then((m) => ({ default: m.SettingsScreen })));
const ProjectsScreen    = lazy(() => import("./screens/planner").then((m) => ({ default: m.ProjectsScreen })));
const SkillsScreen      = lazy(() => import("./screens/skills").then((m) => ({ default: m.SkillsScreen })));
const AgentsScreen      = lazy(() => import("./screens/agents").then((m) => ({ default: m.AgentsScreen })));

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
function ScreenFallback() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
      loading…
    </div>
  );
}

// ── New-tab dialog ────────────────────────────────────────────────────────────

const LAYOUTS: string[] = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"];

/** Delay (ms after hydration) before the perf monitor + store-write diagnostics start, so they don't
 *  load the cold-start window (#1033). Metrics during boot have no diagnostic value. */
const METRICS_GRACE_MS = 5000;

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

// Render a detached page's section. A switch over literal cases (not a dynamic
// lookup keyed by the URL-supplied `page`) so there's no user-controlled dispatch.
function renderDetachedSection(page: string, section: string): React.ReactNode {
  switch (page) {
    case "automations": return <AutomationsScreen sectionOverride={section} />;
    case "skills":      return <SkillsScreen sectionOverride={section} />;
    case "mcp":         return <McpScreen sectionOverride={section} />;
    case "agents":      return <AgentsScreen sectionOverride={section} />;
    case "github":      return <GitHubScreen sectionOverride={section} />;
    case "projects":    return <ProjectsScreen sectionOverride={section} />;
    default:
      return (
        <div style={{ padding: 24, fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>
          Unknown detached page: {page}
        </div>
      );
  }
}

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();
  useScheduler();
  useTunnelSync(); // always-on relay pane mirror (incl. the planner pane) (#801)
  useWarden();     // always-on fleet conformance warden — hard-pauses a drifted worker (#1102)
  useWorkerAutoEnd(); // auto-end a finished worker on PTY exit, from plan.db issue status (#920)
  useTunnelAutomations(); // project automations + accept arm/run-now from a paired phone (#937)
  useTunnelCoordControl(); // route a paired phone's wake/approve into the coordinator (#935)

  const {
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
    addTab, closeTab, renameTab, setTabLayout, moveTab,
    detachedTabIds, setTabDetached,
    focusedAgentName,
    activeRepoName,
    automationsTab,
    settingsSection,
    projectsView,
    setBscBaseDir,
    accent,
    hasHydrated,
  } = useAppStore();

  // Apply the chosen accent to the design-token CSS vars at the document root,
  // live on change and after persisted state rehydrates. Inline vars on :root
  // override the stylesheet defaults; the default accent is a no-op restore.
  useEffect(() => {
    const { accent: a, accentDim } = accentVars(accent);
    const root = document.documentElement;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-dim", accentDim);
  }, [accent]);

  // Startup timing trace (#perf): mark the gate commit, then the first paint of the
  // real UI once the store rehydrates — logStartupTrace emits the breakdown once.
  useEffect(() => { markBoot("mounted"); }, []);
  useEffect(() => {
    if (!hasHydrated) return;
    markBoot("hydrated");
    requestAnimationFrame(() => { markBoot("painted"); logStartupTrace(); });
  }, [hasHydrated]);

  // Lazy-mount Projects on first visit, then keep it mounted so its local state + PTY survive
  // (the heavy planner chunk thus loads on first navigation, not at boot — #perf).
  const projectsEverShown = useRef(false);
  if (activeScreen === "projects") projectsEverShown.current = true;

  // Detached tab window (#430): when opened via tear-off (?detachTab=<id>), this
  // window renders only that console tab — pinned by stable id (resolved to an
  // index for ConsoleScreen's override). Computed once per window load.
  const [detachId] = useState(() => detachedTabId());
  const detachIdx = detachId !== null ? tabs.findIndex((t) => t.id === detachId) : -1;
  // Detached page-section window (#463): ?detach=<page>&section=<id> renders just
  // that page's section, no chrome. Computed once per window load.
  const [detSection] = useState(() => detachedSection());

  // Fetch the app-managed base directory once so the rest of the UI can
  // compute repo local paths deterministically without round-tripping Rust.
  useEffect(() => {
    invoke<string>("get_base_dir")
      .then(setBscBaseDir)
      .catch((e) => log.error(`get_base_dir failed: ${e}`));
    // Crash recovery (#1041): learn once whether the previous shutdown was unclean — gates the
    // restore banner + session auto-resume (a clean quit leaves sessions dormant).
    invoke<boolean>("was_unclean_shutdown")
      .then((v) => useAppStore.getState().setUncleanShutdown(v))
      .catch(() => { /* command absent (e.g. tests) — leave false */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defer the perf monitor + store-write diagnostics past the cold-start window (#1033). Both run
  // every 2s and add IPC + sampling load that's pure overhead while the app is still booting (and
  // useless before it's interactive) — start them a few seconds after hydration instead of at mount.
  useEffect(() => {
    if (!hasHydrated) return;
    let unsub: (() => void) | undefined;
    const id = setTimeout(() => {
      // Watch the main thread for jank (logs `[perf] main thread blocked …`).
      startPerfMonitor();
      // Count how often each store key changes, so a re-render loop reveals which key drives it.
      unsub = useAppStore.subscribe((state, prev) => {
        const s = state as unknown as Record<string, unknown>;
        const p = prev as unknown as Record<string, unknown>;
        for (const k in s) {
          if (s[k] !== p[k]) recordStoreWrite(k);
        }
      });
    }, METRICS_GRACE_MS);
    return () => { clearTimeout(id); unsub?.(); };
  }, [hasHydrated]);

  const titleWorkspace = (() => {
    const parts: string[] = [];
    switch (activeScreen) {
      case "console":
        parts.push("Console");
        if (tabs[activeTabIdx]?.name) parts.push(tabs[activeTabIdx].name);
        if (focusedAgentName) parts.push(focusedAgentName);
        break;
        break;
      case "github":
        parts.push("GitHub");
        if (activeRepoName) parts.push(activeRepoName);
        break;
      case "automation":
        parts.push("Automations");
        parts.push(automationsTab);
        break;
      case "mcp":
        parts.push("MCP");
        break;
      case "projects":
        parts.push("Projects");
        if (projectsView === "planning") parts.push("planning");
        break;
      case "skills":
        parts.push("Skills");
        break;
      case "agents":
        parts.push("Permissions");
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
    const tab = tabs[tabIdx];
    for (let i = 0; i < c * r; i++) {
      // Kill the pane's RESOLVED identity id (#1176) — manual panes are `man:<tabId>:p<idx>`,
      // so the old positional `t{tabIdx}p{i}` would miss the real session and leak it.
      invoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }).catch(console.error);
    }
  }

  async function handleLayoutChange(tabIdx: number, layout: string) {
    const tab = tabs[tabIdx];
    const [oldCols, oldRows] = tab.layout.split("×").map(Number);
    const [newCols, newRows] = layout.split("×").map(Number);
    const oldCount = oldCols * oldRows;
    const newCount = newCols * newRows;
    // Kill PTY sessions for panes that will no longer exist (resolved identity id, #1176).
    if (newCount < oldCount) {
      for (let i = newCount; i < oldCount; i++) {
        invoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }).catch(console.error);
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

  // Detached page-section window: minimal chrome, just that page's section.
  if (detSection) {
    return (
      <div className="app">
        <Titlebar workspace={`${detSection.page} · ${detSection.section}`} />
        <div className="shell">
          <div className="main">
            <div className="page">
              {hasHydrated && <Suspense fallback={<ScreenFallback />}>{renderDetachedSection(detSection.page, detSection.section)}</Suspense>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Detached tab window: minimal chrome (no rail/tabstrip), just this tab's console.
  if (detachId !== null) {
    return (
      <div className="app">
        <Titlebar workspace={detachIdx >= 0 ? (tabs[detachIdx]?.name ?? "Console") : "Console"} />
        <div className="shell">
          <div className="main">
            <div className="page">
              {hasHydrated && detachIdx >= 0 && (
                <div style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0 }}>
                  <ConsoleScreen tabIdxOverride={detachIdx} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <SuperUserAchievement />
      <Titlebar workspace={titleWorkspace} />
      <CrashRecoveryBanner />
      <QuarantineBanner />
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
              hiddenIds={detachedTabIds}
              onTearOff={(idx) => {
                const t = tabs[idx];
                if (!t?.id) return;
                openDetachedTab(t.id, t.name, () => setTabDetached(t.id!, false));
                setTabDetached(t.id, true);
                // If the active tab was the one torn off, move focus to the first
                // tab still in the bar so the window isn't left on a hidden tab.
                if (activeTabIdx === idx) {
                  const next = tabs.findIndex((x, i) => i !== idx && !detachedTabIds.includes(x.id ?? ""));
                  if (next >= 0) setActiveTab(next);
                }
              }}
            />
          )}
          {/* ConsoleScreen stays mounted across all screen navigations so xterm
              instances and PTY sessions are never torn down unnecessarily. CSS
              hides it when another screen is active. */}
          <div className="page">
          <ErrorBoundary label="this view" resetKeys={[activeScreen]}>
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
          {/* Projects lazy-mounts on first visit, then stays mounted so its local state + PTY
              sessions survive screen switches (CSS hides it when inactive). */}
          {projectsEverShown.current && (
            <div style={{ display: activeScreen === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
              <Suspense fallback={<ScreenFallback />}><ProjectsScreen /></Suspense>
            </div>
          )}
          {/* The remaining screens mount only while active — their chunks load on first nav. */}
          <Suspense fallback={<ScreenFallback />}>
            {activeScreen === "github"     && <GitHubScreen />}
            {activeScreen === "automation" && <AutomationsScreen />}
            {activeScreen === "mcp" && <McpScreen />}
            {activeScreen === "skills"     && <SkillsScreen />}
            {activeScreen === "agents"     && <AgentsScreen />}
            {activeScreen === "settings"   && <SettingsScreen />}
          </Suspense>
          </ErrorBoundary>
          </div>
          <StatusBar extra={
            activeScreen === "automation"
              ? <AutomationsStatus />
            : activeScreen === "skills"
              ? <SkillsStatus />
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
