import { Suspense } from "react";
import { Titlebar } from "@/app/chrome/Titlebar";
import { Rail } from "@/app/chrome/Rail";
import { locationCrumb } from "@/app/chrome/locationCrumb";
import { Tabstrip } from "@/app/chrome/Tabstrip";
import { StatusBar } from "@/app/chrome/StatusBar";
import { ErrorBoundary } from "@/app/safety/ErrorBoundary";
import { useAppStore } from "@/store";
import { useAppRepoRoot } from "@/shared/hooks/useAppRepoRoot";
import { Box } from "@/shared/ui/layout/Box";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { useHotkeys } from "./useHotkeys";
import { useNavigateBridge } from "./useNavigateBridge";
import { useFleetWakeBridge } from "./useFleetWakeBridge";
import { useDebugChannel } from "./useDebugChannel";
import { useDockBack } from "./useDockBack";
import { useScheduler } from "@/features/automations";
import { useTunnelSync, useStoreProjector, useTunnelAutomations, useTunnelHookTelemetry, useTunnelCoordControl } from "@/features/tunnel";
// #4186: Console renders FROM THE GRAPH — the host mounts the authored `consolepage` node. The file
// component stays exported from the barrel and is NOT going away — both copies coexist, held identical by
// the record↔file parity guard (`app/runtime/graphParity.test.ts`).
import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { DebugSessionMount, RequestSessionsMount } from "@/features/debug";
import { StudioSessionHosts } from "@/features/studio-sessions";
import { useConsoleTabs } from "@/app/console/useConsoleTabs";
import { ConsoleEmptyState } from "@/app/console/ConsoleEmptyState";
import { AutomationsStatus } from "@/features/automations";
import { SkillsStatus } from "@/features/skills";
import { Achievements } from "@/app/Achievement";
import { AppBanners } from "@/app/AppBanners";
import { LiveRegion } from "@/shared/ui/feedback/LiveRegion";
import { useCoordAnnouncer } from "@/app/a11y/useCoordAnnouncer";
import { useCoordSpeaker } from "@/app/a11y/useCoordSpeaker";
import { useWarden } from "@/shared/lib/fleet/useWarden";
import { useWorkerAutoEnd } from "@/shared/lib/fleet/useWorkerAutoEnd";
import { useNotificationSounds } from "@/features/sounds";
import { useAppBoot } from "@/app/useAppBoot";
import { useNavHistory } from "@/shared/hooks/useNavHistory";
import { DetachedWindow, isDetachedWindow } from "@/app/DetachedWindow";
import { effectiveWorkspace } from "@/app/registry";
import {
  GitHubWorkspace, AutomationsWorkspace, McpWorkspace, SettingsWorkspace,
  ProjectsWorkspace, SkillsWorkspace, SecurityWorkspace, GlanceWorkspace, WorkspaceFallback,
} from "@/app/lazyWorkspaces";

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();
  // #3274: apply `bsc navigate` requests from the appchan watcher (Rust emits `bsc://navigate`), so an
  // external session can steer the app to a view before capturing it.
  useNavigateBridge();
  useFleetWakeBridge();
  // #3437: answer `bsc debug` — read-only inspection of the live DOM + preview state, so a session can
  // ask what is actually on screen instead of inferring it from source.
  useDebugChannel();
  // #3919: take a torn-off page back when its window drags the tab home. Main window ONLY — the hooks
  // above this file's `isDetachedWindow()` early return run in BOTH windows, and a detached window must
  // not re-dock its own page.
  useDockBack(!isDetachedWindow());
  useScheduler();
  useTunnelSync(); // always-on relay pane mirror (incl. the planner pane) (#801)
  useStoreProjector(); // generic store_state projector: scoped domains + the alert pipeline (#2498)
  useWarden();     // always-on fleet conformance warden — hard-pauses a drifted worker (#1102)
  useWorkerAutoEnd(); // auto-end a finished worker on PTY exit, from plan.db issue status (#920)
  useNotificationSounds(); // opt-in Signal-kit cues on fleet coord events (default off) (#3082)
  useTunnelAutomations(); // project automations + accept arm/run-now from a paired phone (#937)
  useTunnelHookTelemetry(); // project read-only hook-fire telemetry to a paired phone (#937)
  useTunnelCoordControl(); // route a paired phone's wake/approve into the coordinator (#935)
  useCoordAnnouncer(); // announce structured coord events to the screen reader via the live region (#3770)
  useCoordSpeaker(); // and SPEAK them via app-owned TTS when opted in (#3804, Tier 1) — sits alongside
  useAppBoot();    // accent vars · startup trace · base-dir/crash/skills hydration · deferred perf monitor
  useNavHistory(); // mouse back/forward (X1/X2) → app-wide navigation history (workspace + Glance drill)

  // Per-field selectors, NOT a bare `useAppStore()` (#3612): the shell is always mounted, and a
  // whole-store read re-renders the ENTIRE app tree (9 terminals + the 154-component Studio + Glance) on
  // EVERY store mutation anywhere — including the Design Studio scan's ~308 componentBuildStatus writes,
  // which produced the measured 100–386 ms jank. Subscribing per field compares by Object.is, so an
  // unrelated write stays silent. (Same pattern the console pinned in storeSelectors.test.tsx.)
  const rawActiveWorkspace = useAppStore((s) => s.activeWorkspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabIdx = useAppStore((s) => s.activeTabIdx);
  const focusedAgentName = useAppStore((s) => s.focusedAgentName);
  const activeRepoName = useAppStore((s) => s.activeRepoName);
  const activePageTab = useAppStore((s) => s.activePageTab);
  const crumbEntity = useAppStore((s) => s.crumbEntity);
  const projectsPageMode = useAppStore((s) => s.projectsPageMode);
  const projectsView = useAppStore((s) => s.projectsView);
  const githubTab = useAppStore((s) => s.githubTab);
  const githubBoardOpen = useAppStore((s) => s.githubBoardOpen);
  const githubBoardTab = useAppStore((s) => s.githubBoardTab);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const hasHydrated = useAppStore((s) => s.hasHydrated);
  const showConsolePage = useAppStore((s) => s.showConsolePage);

  // The legacy Console page is opt-in (#2372). When it's off, a persisted (or just-toggled-off)
  // console-active workspace falls back to Glance — derived, so every downstream `activeWorkspace`
  // check (rail highlight, chrome, the console mount's display:none) redirects with no reset effect.
  // The console STILL mounts hidden (its PTYs stay alive for the Glance stream dock to reconnect).
  // effectiveWorkspace (registry.ts) is the shared definition — useHotkeys gates on it too (#3575).
  const activeWorkspace = effectiveWorkspace(rawActiveWorkspace, showConsolePage);

  // Resolve the app's own source tree once (#3509) so a launch can turn a role's symbolic
  // `app-repo` harvest root into a real path without awaiting.
  useAppRepoRoot();

  // The console owns its tabs: the layout picker, close (+ a confirm when a session is live),
  // layout change (PTY teardown), reorder, tear-off — all behind useConsoleTabs (#app-shell).
  const consoleTabs = useConsoleTabs();

  // Projects lazy-mounts on first visit, then stays mounted so its local state + PTY survive a
  // screen switch (the heavy planner chunk thus loads on first navigation, not at boot — #perf).
  // Kept-mounted via <KeptMountedPage> below.
  // Design Studio is no longer a rail Workspace — it's a Planner tab (projectsPageMode "designs"), mounted
  // by ProjectsWorkspace, so it rides Projects' keep-mounted treatment and its designer PTY (#2585) still
  // survives screen switches.

  // The "you are here" position crumb: the Workspace's canonical name (registry.ts — the same source
  // the rail nav uses, so they can't drift) followed by its active PAGE (and any further in-page detail).
  // The full mapping — every workspace's page — lives in the pure, unit-tested `locationCrumb` (#3036).
  const titleWorkspace = locationCrumb({
    activeWorkspace,
    activePageTab,
    crumbEntity,
    projectsPageMode,
    projectsView,
    githubTab,
    githubBoardOpen,
    githubBoardTab,
    activeRepoName,
    settingsSection,
    consoleTab: tabs[activeTabIdx]?.name,
    focusedAgentName,
  });

  // Hold the first paint until the async-persisted state has hydrated, so screens
  // don't flash from store defaults (e.g. GitHub "not connected" → connected) on
  // load. Hydration is a fast local read — a brief blank-canvas frame, not a wait.
  if (!hasHydrated) return <Box className="app" />;

  // Tear-off windows (#430/#463) render minimal chrome — just the one detached surface.
  if (isDetachedWindow()) return <DetachedWindow />;

  return (
    // TerminalHost (#2378) owns the single <TerminalView> per agent and re-parents it between the console
    // grid cells and the Glance dock — so wrapping the whole shell gives both surfaces the same host.
    <TerminalHost>
    <Box className="app">
      <LiveRegion />
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
              <ConsoleGraphHost />
            </Box>
          )}
          {activeWorkspace === "console" && tabs.length === 0 && (
            <ConsoleEmptyState onNew={consoleTabs.openNewTab} />
          )}
          {/* Projects lazy-mounts on first visit, then stays mounted so its local state + PTY
              sessions survive screen switches (CSS hides it when inactive). */}
          <KeptMountedPage active={activeWorkspace === "projects"} fallback={<WorkspaceFallback />}>
            <ProjectsWorkspace />
          </KeptMountedPage>
          {/* The remaining screens mount only while active — their chunks load on first nav. */}
          <Suspense fallback={<WorkspaceFallback />}>
            {activeWorkspace === "glance"     && <GlanceWorkspace />}
            {activeWorkspace === "github"     && <GitHubWorkspace />}
            {activeWorkspace === "automation" && <AutomationsWorkspace />}
            {activeWorkspace === "mcp" && <McpWorkspace />}
            {activeWorkspace === "skills"     && <SkillsWorkspace />}
            {activeWorkspace === "security"     && <SecurityWorkspace />}
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
    {/* Keeps the app-owned DEBUG session's PTY warm on TerminalHost while the Settings flag is on (#3326),
        so the Glance `debugger` node's morph can re-parent it in. Renders off-screen / null. */}
    <DebugSessionMount />
    {/* #3498: a debug session per open request. Inert while auto-spawn is off (the default). */}
    <RequestSessionsMount />
    {/* Keeps each WANTED app-owned studio session (designer/librarian/architect) warm on TerminalHost
        (#3357), so its page dock and its Glance node morph can both re-parent the one live terminal in.
        Lazily started by whichever surface first shows it; reclaimed by the 30-minute idle reaper. */}
    <StudioSessionHosts />
    </TerminalHost>
  );
}
