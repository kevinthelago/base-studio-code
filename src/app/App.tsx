import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { markBoot, logStartupTrace } from "@/shared/lib/core/startupTrace";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { LayoutGrid } from "lucide-react";
import { Titlebar } from "@/app/chrome/Titlebar";
import { Rail } from "@/app/chrome/Rail";
import { workspaceLabel } from "@/app/registry";
import { Tabstrip } from "@/app/chrome/Tabstrip";
import { StatusBar } from "@/app/chrome/StatusBar";
import { Dialog } from "@/shared/ui/Dialog";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { useAppStore } from "@/store";
import { useHotkeys } from "./useHotkeys";
import { useScheduler } from "@/features/automations/useScheduler";
import { useTunnelSync, useTunnelAutomations, useTunnelCoordControl } from "@/features/tunnel";
import { startPerfMonitor, recordStoreWrite } from "@/shared/lib/core/perf";
import { log } from "@/shared/lib/core/log";
import { ConsoleWorkspace } from "@/app/console";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { AutomationsStatus } from "@/features/automations/AutomationsStatus";
import { SkillsStatus } from "@/features/skills/SkillsStatus";
import type { Tab } from "@/app/chrome/Tabstrip";
import { SuperUserAchievement } from "@/app/SuperUserAchievement";
import { CrashRecoveryBanner } from "@/app/CrashRecoveryBanner";
import { SessionRecoveryBanner } from "@/app/SessionRecoveryBanner";
import { QuarantineBanner } from "@/app/QuarantineBanner";
import { useWarden } from "@/shared/lib/fleet/useWarden";
import { useWorkerAutoEnd } from "@/shared/lib/fleet/useWorkerAutoEnd";
import { openDetachedTab, detachedTabId, detachedSection } from "@/app/console/lib/detachWindow";
import { accentVars } from "@/features/settings/lib/appearance";

// Lazy-loaded screens (#perf): only the Console is needed at boot. Each other screen's chunk
// loads on first navigation, keeping the heavy module graph (esp. the planner) off the cold
// startup path — both the dev transform and the production bundle.
const GitHubWorkspace      = lazy(() => import("@/features/github").then((m) => ({ default: m.GitHubWorkspace })));
const AutomationsWorkspace = lazy(() => import("@/features/automations").then((m) => ({ default: m.AutomationsWorkspace })));
const McpWorkspace         = lazy(() => import("@/features/mcp").then((m) => ({ default: m.McpWorkspace })));
const SettingsWorkspace    = lazy(() => import("@/features/settings").then((m) => ({ default: m.SettingsWorkspace })));
const ProjectsWorkspace    = lazy(() => import("@/features/planner").then((m) => ({ default: m.ProjectsWorkspace })));
const SkillsWorkspace      = lazy(() => import("@/features/skills").then((m) => ({ default: m.SkillsWorkspace })));
const AgentsWorkspace      = lazy(() => import("@/features/agents").then((m) => ({ default: m.AgentsWorkspace })));

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
function WorkspaceFallback() {
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
    case "automations": return <AutomationsWorkspace pageOverride={section} />;
    case "skills":      return <SkillsWorkspace pageOverride={section} />;
    case "mcp":         return <McpWorkspace pageOverride={section} />;
    case "agents":      return <AgentsWorkspace pageOverride={section} />;
    case "github":      return <GitHubWorkspace pageOverride={section} />;
    case "projects":    return <ProjectsWorkspace pageOverride={section} />;
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
    activeWorkspace, setWorkspace,
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
  if (activeWorkspace === "projects") projectsEverShown.current = true;

  // Detached tab window (#430): when opened via tear-off (?detachTab=<id>), this
  // window renders only that console tab — pinned by stable id (resolved to an
  // index for ConsoleWorkspace's override). Computed once per window load.
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
    // Skills library (#1338 ph2): hydrate from the global skills.db so the desktop UI, the planner,
    // and every live `bsc-skill` session share ONE library. Reconciles the code-owned packaged set
    // and seeds the db on first run; a no-op when the bridge is absent (keeps the seeded set).
    void useAppStore.getState().hydrateSkills();
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

  // The "you are here" position crumb: the screen's canonical name (from the registry — the same
  // source the rail nav uses, so they can't drift) followed by any in-screen detail (the active
  // tab/agent, repo, sub-section). Only the DETAIL lives here; the page NAME is never hardcoded.
  const titleWorkspace = (() => {
    const parts: string[] = [workspaceLabel(activeWorkspace)];
    switch (activeWorkspace) {
      case "console":
        if (tabs[activeTabIdx]?.name) parts.push(tabs[activeTabIdx].name);
        if (focusedAgentName) parts.push(focusedAgentName);
        break;
      case "github":
        if (activeRepoName) parts.push(activeRepoName);
        break;
      case "automation":
        parts.push(automationsTab);
        break;
      case "projects":
        if (projectsView === "planning") parts.push("planning");
        break;
      case "settings":
        parts.push(settingsSection);
        break;
    }
    return parts.filter(Boolean).join(" — ");
  })();

  const [confirmCloseIdx, setConfirmCloseIdx] = useState<number | null>(null);
  const [showNewTab, setShowNewTab] = useState(false);

  // Also handle ⌘T hotkey for new tab
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "t" && activeWorkspace === "console") {
        e.preventDefault();
        setShowNewTab(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeWorkspace]);

  function killTabPtys(tabIdx: number, layout: string) {
    const [c, r] = layout.split("×").map(Number);
    const tab = tabs[tabIdx];
    for (let i = 0; i < c * r; i++) {
      // Kill the pane's RESOLVED identity id (#1176) — manual panes are `man:<tabId>:p<idx>`,
      // so the old positional `t{tabIdx}p{i}` would miss the real session and leak it.
      fireInvoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }, console.error);
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
        fireInvoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }, console.error);
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
              {hasHydrated && <Suspense fallback={<WorkspaceFallback />}>{renderDetachedSection(detSection.page, detSection.section)}</Suspense>}
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
                  <ConsoleWorkspace tabIdxOverride={detachIdx} />
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
      <SessionRecoveryBanner />
      <QuarantineBanner />
      <div className="shell">
        <Rail active={activeWorkspace} onNavigate={setWorkspace} />
        <div className="main">
          {activeWorkspace === "console" && (
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
          {/* ConsoleWorkspace stays mounted across all screen navigations so xterm
              instances and PTY sessions are never torn down unnecessarily. CSS
              hides it when another screen is active. */}
          <div className="page">
          <ErrorBoundary label="this view" resetKeys={[activeWorkspace]}>
          {tabs.length > 0 && (
            <div style={{
              display: activeWorkspace === "console" ? "flex" : "none",
              flex: 1, flexDirection: "column", minHeight: 0,
            }}>
              <ConsoleWorkspace />
            </div>
          )}
          {activeWorkspace === "console" && tabs.length === 0 && (
            <ConsoleEmptyState onNew={() => setShowNewTab(true)} />
          )}
          {/* Projects lazy-mounts on first visit, then stays mounted so its local state + PTY
              sessions survive screen switches (CSS hides it when inactive). */}
          {projectsEverShown.current && (
            <div style={{ display: activeWorkspace === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
              <Suspense fallback={<WorkspaceFallback />}><ProjectsWorkspace /></Suspense>
            </div>
          )}
          {/* The remaining screens mount only while active — their chunks load on first nav. */}
          <Suspense fallback={<WorkspaceFallback />}>
            {activeWorkspace === "github"     && <GitHubWorkspace />}
            {activeWorkspace === "automation" && <AutomationsWorkspace />}
            {activeWorkspace === "mcp" && <McpWorkspace />}
            {activeWorkspace === "skills"     && <SkillsWorkspace />}
            {activeWorkspace === "agents"     && <AgentsWorkspace />}
            {activeWorkspace === "settings"   && <SettingsWorkspace />}
          </Suspense>
          </ErrorBoundary>
          </div>
          <StatusBar extra={
            activeWorkspace === "automation"
              ? <AutomationsStatus />
            : activeWorkspace === "skills"
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
