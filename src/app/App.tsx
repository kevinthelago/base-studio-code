import { useRef, Suspense } from "react";
import { Titlebar } from "@/app/chrome/Titlebar";
import { Rail } from "@/app/chrome/Rail";
import { workspaceLabel } from "@/app/registry";
import { Tabstrip } from "@/app/chrome/Tabstrip";
import { StatusBar } from "@/app/chrome/StatusBar";
import { ErrorBoundary } from "@/app/safety/ErrorBoundary";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { useHotkeys } from "./useHotkeys";
import { useScheduler } from "@/features/automations/useScheduler";
import { useTunnelSync, useTunnelAutomations, useTunnelCoordControl } from "@/features/tunnel";
import { ConsoleWorkspace } from "@/app/console";
import { useConsoleTabs } from "@/app/console/useConsoleTabs";
import { ConsoleEmptyState } from "@/app/console/ConsoleEmptyState";
import { AutomationsStatus } from "@/features/automations/AutomationsStatus";
import { SkillsStatus } from "@/features/skills/SkillsStatus";
import { Achievements } from "@/app/Achievement";
import { AppBanners } from "@/app/AppBanners";
import { useWarden } from "@/shared/lib/fleet/useWarden";
import { useWorkerAutoEnd } from "@/shared/lib/fleet/useWorkerAutoEnd";
import { useAppBoot } from "@/app/useAppBoot";
import { useNavHistory } from "@/shared/hooks/useNavHistory";
import { DetachedWindow, isDetachedWindow } from "@/app/DetachedWindow";
import {
  GitHubWorkspace, AutomationsWorkspace, McpWorkspace, SettingsWorkspace,
  ProjectsWorkspace, SkillsWorkspace, AgentsWorkspace, GlanceWorkspace, DesignWorkspace, WorkspaceFallback,
} from "@/app/lazyWorkspaces";

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();
  useScheduler();
  useTunnelSync(); // always-on relay pane mirror (incl. the planner pane) (#801)
  useWarden();     // always-on fleet conformance warden — hard-pauses a drifted worker (#1102)
  useWorkerAutoEnd(); // auto-end a finished worker on PTY exit, from plan.db issue status (#920)
  useTunnelAutomations(); // project automations + accept arm/run-now from a paired phone (#937)
  useTunnelCoordControl(); // route a paired phone's wake/approve into the coordinator (#935)
  useAppBoot();    // accent vars · startup trace · base-dir/crash/skills hydration · deferred perf monitor
  useNavHistory(); // mouse back/forward (X1/X2) → app-wide navigation history (workspace + Glance drill)

  const {
    activeWorkspace, setWorkspace,
    tabs, activeTabIdx,
    focusedAgentName,
    activeRepoName,
    automationsTab,
    settingsSection,
    projectsView,
    hasHydrated,
  } = useAppStore();

  // The console owns its tabs: the layout picker, close (+ a confirm when a session is live),
  // layout change (PTY teardown), reorder, tear-off — all behind useConsoleTabs (#app-shell).
  const consoleTabs = useConsoleTabs();

  // Lazy-mount Projects on first visit, then keep it mounted so its local state + PTY survive
  // (the heavy planner chunk thus loads on first navigation, not at boot — #perf).
  const projectsEverShown = useRef(false);
  if (activeWorkspace === "projects") projectsEverShown.current = true;

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

  // Hold the first paint until the async-persisted state has hydrated, so screens
  // don't flash from store defaults (e.g. GitHub "not connected" → connected) on
  // load. Hydration is a fast local read — a brief blank-canvas frame, not a wait.
  if (!hasHydrated) return <Box className="app" />;

  // Tear-off windows (#430/#463) render minimal chrome — just the one detached surface.
  if (isDetachedWindow()) return <DetachedWindow />;

  return (
    <Box className="app">
      <Achievements />
      <Titlebar workspace={titleWorkspace} />
      <AppBanners />
      <Box className="shell">
        <Rail active={activeWorkspace} onNavigate={setWorkspace} />
        <Box className="main">
          {activeWorkspace === "console" && <Tabstrip {...consoleTabs.tabstripProps} />}
          {/* ConsoleWorkspace stays mounted across all screen navigations so xterm
              instances and PTY sessions are never torn down unnecessarily. CSS
              hides it when another screen is active. */}
          <Box className="page">
          <ErrorBoundary label="this view" resetKeys={[activeWorkspace]}>
          {tabs.length > 0 && (
            <Box style={{
              display: activeWorkspace === "console" ? "flex" : "none",
              flex: 1, flexDirection: "column", minHeight: 0,
            }}>
              <ConsoleWorkspace />
            </Box>
          )}
          {activeWorkspace === "console" && tabs.length === 0 && (
            <ConsoleEmptyState onNew={consoleTabs.openNewTab} />
          )}
          {/* Projects lazy-mounts on first visit, then stays mounted so its local state + PTY
              sessions survive screen switches (CSS hides it when inactive). */}
          {projectsEverShown.current && (
            <Box style={{ display: activeWorkspace === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
              <Suspense fallback={<WorkspaceFallback />}><ProjectsWorkspace /></Suspense>
            </Box>
          )}
          {/* The remaining screens mount only while active — their chunks load on first nav. */}
          <Suspense fallback={<WorkspaceFallback />}>
            {activeWorkspace === "glance"     && <GlanceWorkspace />}
            {activeWorkspace === "github"     && <GitHubWorkspace />}
            {activeWorkspace === "automation" && <AutomationsWorkspace />}
            {activeWorkspace === "mcp" && <McpWorkspace />}
            {activeWorkspace === "skills"     && <SkillsWorkspace />}
            {/* Design Studio — the Component Library pane fills its container (height:100%),
                so give it a flex-fill wrapper like the other self-measuring surfaces (#2303). */}
            {activeWorkspace === "design"     && (
              <Box style={{ flex: 1, minHeight: 0, display: "flex" }}><DesignWorkspace /></Box>
            )}
            {activeWorkspace === "agents"     && <AgentsWorkspace />}
            {activeWorkspace === "settings"   && <SettingsWorkspace />}
          </Suspense>
          </ErrorBoundary>
          </Box>
          <StatusBar extra={
            activeWorkspace === "automation"
              ? <AutomationsStatus />
            : activeWorkspace === "skills"
              ? <SkillsStatus />
              : undefined
          } />
        </Box>
      </Box>

      {/* Console tab dialogs (new-tab layout picker + close-confirm) — owned by useConsoleTabs. */}
      {consoleTabs.dialogs}
    </Box>
  );
}
