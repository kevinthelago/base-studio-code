import { Suspense } from "react";
import { Titlebar } from "@/app/chrome/Titlebar";
import { Rail } from "@/app/chrome/Rail";
import { locationCrumb } from "@/app/chrome/locationCrumb";
import { StatusBar } from "@/app/chrome/StatusBar";
import { ErrorBoundary } from "@/app/safety/ErrorBoundary";
import { useAppStore } from "@/store";
import { useAppRepoRoot } from "@/shared/hooks/useAppRepoRoot";
import { Box } from "@/shared/ui/layout/Box";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { useHotkeys } from "@/app/useHotkeys";
import { useNavigateBridge } from "@/app/useNavigateBridge";
// The app-owned pumps, mounted in ONE window — see the note at the mount below.
import { AppPumps } from "@/app/AppPumps";
import { isAgentViewWindow } from "@/shared/lib/core/windowRole";
// #4186: Console renders FROM THE GRAPH — the host mounts the authored `consolepage` node. The file
// component stays exported from the barrel and is NOT going away — both copies coexist. They are no
// longer held IDENTICAL: the record↔file parity guard was retired (see the note in
// `app/runtime/shadowPages.ts`), because a record deliberately diverges from its file to render
// standalone in the preview. What still holds is that the record is what MOUNTS.
import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { RequestSessionsMount } from "@/features/debug";
import { StudioSessionHosts } from "@/features/studio-sessions";
import { Achievements } from "@/app/Achievement";
import { AppBanners } from "@/app/AppBanners";
import { LiveRegion } from "@/shared/ui/feedback/LiveRegion";
import { useAppBoot } from "@/app/useAppBoot";
import { useNavHistory } from "@/shared/hooks/useNavHistory";
import { DetachedWindow, isDetachedWindow } from "@/app/DetachedWindow";
import { effectiveWorkspace } from "@/app/registry";
import {
  SettingsWorkspace,
  LogsWorkspace, GlanceWorkspace, WorkspaceFallback,
  ComponentsWorkspace, TeamsWorkspace, AlgorithmsWorkspace, DataWorkspace, SoundsWorkspace,
  MemoryWorkspace, CredentialsWorkspace, LanWorkspace, JobsWorkspace,
} from "@/app/lazyWorkspaces";

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  useHotkeys();
  // The ACTIVE `bsc` command surfaces (`a-persona-declares-its-command-surfaces`), read from the ONE
  // catalog into the store so both consumers share it: the session launch complements it against each
  // persona's declared set to build that session's denies, and the Glance drill draws the band.
  //
  // IT POLLS HERE, IN THE SHELL, and not in Glance — which is where the first read lived. A session is
  // launched from the Console, from the fleet, and headlessly via `bsc fleet start`, none of which
  // require Glance to have mounted; leaving the poll on a workspace meant the catalog was empty for
  // exactly the launches nobody had opened Glance for, and an empty catalog denies nothing.
  //
  // The 60s cadence is far above how often the catalog changes (it is a `const` compiled into the
  // binary, so only a rebuild moves it — which does happen mid-session, since that re-stages the
  // sidecar) and far below how long a stale set would matter. The read is on the warm-serve
  // allow-list, so it costs ~10ms and needs no project key.
  // #3274: apply `bsc navigate` requests from the appchan watcher (Rust emits `bsc://navigate`), so an
  // external session can steer the app to a view before capturing it. EVERY window mounts this — it is
  // how a window is driven at all, and Rust names the window each request is for, so a second window
  // hears only what was aimed at it.
  useNavigateBridge();
  useAppBoot();    // accent vars · startup trace · base-dir/crash/skills hydration · deferred perf monitor
  useNavHistory(); // mouse back/forward (X1/X2) → app-wide navigation history (workspace + Glance drill)

  // Per-field selectors, NOT a bare `useAppStore()` (#3612): the shell is always mounted, and a
  // whole-store read re-renders the ENTIRE app tree (9 terminals + the 154-component Studio + Glance) on
  // EVERY store mutation anywhere — including the Design Studio scan's ~308 componentBuildStatus writes,
  // which produced the measured 100–386 ms jank. Subscribing per field compares by Object.is, so an
  // unrelated write stays silent. (Same pattern the console pinned in storeSelectors.test.tsx.)
  const rawActiveWorkspace = useAppStore((s) => s.activeWorkspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const focusedAgentName = useAppStore((s) => s.focusedAgentName);
  const activePageTab = useAppStore((s) => s.activePageTab);
  const crumbEntity = useAppStore((s) => s.crumbEntity);
  const projectsPageMode = useAppStore((s) => s.projectsPageMode);
  const projectsView = useAppStore((s) => s.projectsView);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const hasHydrated = useAppStore((s) => s.hasHydrated);

  // effectiveWorkspace (registry.ts) is the shared indirection the rail, chrome and useHotkeys read;
  // it is identity now that Console is a permanent workspace (the #2372 opt-in is gone).
  const activeWorkspace = effectiveWorkspace(rawActiveWorkspace);

  // Resolve the app's own source tree once (#3509) so a launch can turn a role's symbolic
  // `app-repo` harvest root into a real path without awaiting.
  useAppRepoRoot();

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
    settingsSection,
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
      {/* THE APP-OWNED PUMPS, in ONE window (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`).
          They dispatch commands into panes, reap idle sessions, quarantine drifted workers and speak coord
          events — actions, not rendering, so a second window running them performs each one twice. Mounted
          below the detached early return (a tear-off never reaches here) and skipped in the agent view,
          whose role the APP authored into its URL. Moving them into Rust is
          `an-app-level-pump-runs-once-in-rust-not-once-per-window`; this keeps the second window honest
          until then, and the renderer still decides nothing. */}
      {!isAgentViewWindow() && <AppPumps />}
      <LiveRegion />
      <Achievements />
      <Titlebar workspace={titleWorkspace} />
      <AppBanners />
      <Box className="shell">
        <Rail active={activeWorkspace} onNavigate={setWorkspace} />
        <Box className="main">
          {/* No project Tabstrip: the console hosts SYSTEM sessions (`system-sessions-run-projects-and-start-when-visited`).
              ConsoleWorkspace stays mounted across all screen navigations so xterm
              instances and PTY sessions are never torn down unnecessarily. CSS
              hides it when another screen is active. */}
          <Box className="page">
          <ErrorBoundary label="this view" resetKeys={[activeWorkspace]}>
          <Box style={{
            display: activeWorkspace === "console" ? "flex" : "none",
            flex: 1, flexDirection: "column", minHeight: 0,
          }}>
            <ConsoleGraphHost />
          </Box>
          {/* THE FIVE GRAPHS (`five-graphs-become-rail-workspaces`) get the SAME keep-mounted treatment
              as Projects, and for the same reason: each docks an always-on studio session (the designer,
              librarian, architect and sound-designer), and a screen that unmounts on every rail click
              would kill and relaunch that PTY every time. They were previously kept mounted INSIDE the
              Planner — leaving them as plain `activeWorkspace === x && <X />` would have quietly
              regressed that, and a killed-and-restarted session looks like a slow page, not a bug. */}
          {/* `label` tags the un-hide timing `bsc logs frontend phases` can read
              (`request-177-components-graph-real-app-instrumentation`) — real-app numbers for exactly
              the visit KeptMountedPage exists to make cheap, instead of another synthetic-shell guess. */}
          <KeptMountedPage active={activeWorkspace === "components"} fallback={<WorkspaceFallback />} label="components">
            <ComponentsWorkspace />
          </KeptMountedPage>
          <KeptMountedPage active={activeWorkspace === "algorithms"} fallback={<WorkspaceFallback />} label="algorithms">
            <AlgorithmsWorkspace />
          </KeptMountedPage>
          <KeptMountedPage active={activeWorkspace === "teams"} fallback={<WorkspaceFallback />} label="teams">
            <TeamsWorkspace />
          </KeptMountedPage>
          <KeptMountedPage active={activeWorkspace === "sounds"} fallback={<WorkspaceFallback />} label="sounds">
            <SoundsWorkspace />
          </KeptMountedPage>
          {/* Data is the one graph with no studio and no PTY, so it mounts only while active. */}
          {/* The remaining screens mount only while active — their chunks load on first nav. */}
          <Suspense fallback={<WorkspaceFallback />}>
            {activeWorkspace === "data"       && <DataWorkspace />}
            {activeWorkspace === "glance"     && <GlanceWorkspace />}
            {activeWorkspace === "logs"       && <LogsWorkspace />}
            {activeWorkspace === "settings"   && <SettingsWorkspace />}
            {/* The network the app runs on (`epic-the-lan-workspace`) — re-reads `bsc inventory scene` on mount. */}
            {activeWorkspace === "lan"        && <LanWorkspace />}
            {activeWorkspace === "jobs"       && <JobsWorkspace />}
            {/* Memory re-reads `bsc memory` on every mount, for the same reason Credentials does:
                the store is written from OUTSIDE the app — by every session that runs
                `bsc memory add` — so a kept-mounted copy would be stale exactly when a session has
                just learned something. */}
            {activeWorkspace === "memory"     && <MemoryWorkspace />}
            {/* Credentials re-reads `bsc secret` on every mount rather than staying mounted: the
                store is edited from OUTSIDE the app (a session running `bsc secret`), so a kept-mounted
                copy would show a stale answer to the one question this screen exists to answer. */}
            {activeWorkspace === "credentials" && <CredentialsWorkspace />}
          </Suspense>
          </ErrorBoundary>
          </Box>
          <StatusBar />
        </Box>
      </Box>
    </Box>
    {/* Keeps the app-owned DEBUG session's PTY warm on TerminalHost while the Settings flag is on (#3326),
        so the Glance `debugger` node's morph can re-parent it in. Renders off-screen / null. */}
    {/* #3498: a debug session per open request. Inert while auto-spawn is off (the default). */}
    <RequestSessionsMount />
    {/* Keeps each WANTED app-owned studio session (designer/librarian/architect) warm on TerminalHost
        (#3357), so its page dock and its Glance node morph can both re-parent the one live terminal in.
        Lazily started by whichever surface first shows it; reclaimed by the 30-minute idle reaper. */}
    <StudioSessionHosts />
    </TerminalHost>
  );
}
