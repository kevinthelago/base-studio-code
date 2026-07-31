import { lazy, Suspense } from "react";
import { useAppStore } from "@/store";
import { Screen } from "@/shared/ui/layouts/Screen";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { ProjectsGraphHost } from "./ProjectsGraphHost";
// #3874: the graph-hosted Projects page — built and gated, not yet mounted (see the FLIP POINTs below).
export { ProjectsGraphHost } from "./ProjectsGraphHost";
import { Planning } from "./session/Planning";
import { TeamsPanel } from "@/features/teams";
import { SoundsWorkspace } from "@/features/sounds";
import { useProjectScan } from "./list/useProjectScan";
import { PROJECT_MODES } from "./list/projectModes";
import "./projectsScreen.css";

// #1545: public API for cross-feature consumers. tunnel reaches plannerCore for CanonicalFile;
// components reaches the gist manifest/publish helpers (included for barrel completeness).
export type { CanonicalFile } from "./lib/plannerCore";
// #3760: the `plan` store_state builder lives in the planner feature (the plan domain is planner-
// published, not projected by useStoreProjector); exposed so the tunnel payload-parity harness can
// cover it like every other domain.
export { buildPlanBoardPayload, type PlanBoardPayload } from "./session/planBoardProjection";
export {
  validateManifest, wrapExtension, encodeShareCode, decodeShareCode,
  type ExtensionManifest, type ValidateResult,
} from "./lib/gist/manifest";
// The Planner's page vocabulary (#3274): `bsc navigate page <id>` validates against it, so the shell
// needs the real list rather than a hand-copied one that could drift from the tabs actually rendered.
export { PROJECT_MODES } from "./list/projectModes";
// The project APPLICATION ARCHITECTURE (#3802 → the Glance endpoint-type discriminator, #3786): a
// per-project attribute the planner classifies during Discovery. Exposed on the barrel so cross-feature consumers
// (Glance surfaces it on each project node) reach the type, not the deep `lib/classifyConfig` path.
export type { AppType } from "./lib/classifyConfig";
export { installFromGist, publishGist } from "./lib/gist/gist";
// #1545: github's screen renders planner's project views (a one-way UI dependency now that planner
// no longer reaches into github); the app's director pump + console launch reach planner fleet logic
// (flow-permission rules, director drive). Exposed here so those consumers use the barrel, not deep paths.
export { ProjectsSummary } from "./list/ProjectsSummary";
export { ProjectBoard } from "./github/ProjectBoard";
export { Roadmap } from "./github/Roadmap";
export { Issues } from "./github/Issues";
export { Insights } from "./github/Insights";
export { flowPermissionRules, flowGrantedPushCommands } from "./fleet/flowPermissions";
// #2995: the durable projects-DB bridge — the app shell's boot migration upserts every cached draft
// into the DB through this (reached via the barrel, not a deep path, per the app import boundary).
export { addDbProject, setDbTriaged } from "./list/projectsDbBridge";
// #3966: Glance needs the durable project list too — it was reading the persisted `localDraftProjects`
// cache, which misses any project the cache never got, so a real project could have no graph node.
export { listDbProjects, type DbProject } from "./list/projectsDbBridge";
export {
  decideDirectorAction, resolveDirectorDrive, askKey, pendingAskPrompt,
  briefKey, pendingBriefPrompt,
  requestKey,
  pendingRequestPrompt,
  shouldRemind,
  idleReminderPrompt,
  ASK_REMINDER_MS, DEFAULT_HEARTBEAT_MS, INJECT_COOLDOWN_MS,
} from "./fleet/directorDrive";

// Design Studio (#move-to-planner) — a single-page workspace folded in as the "designs" Planner tab.
// LAZY to break the planner↔components import cycle (components reaches planner for the gist helpers +
// the designer-terminal theme); the chunk loads on first open, then the page stays mounted (below) so
// its always-on designer PTY survives a page switch — the same treatment Planning gets.
const DesignsWorkbenchPage = lazy(() => import("@/features/designs").then((m) => ({ default: m.DesignsWorkbench })));
// Algorithms (#2785) — the knowledge graph, folded in from its own rail Workspace. It DOCKS the always-on
// knowledge-librarian session (#2787/#2827), so like Designs it must stay MOUNTED across tab switches
// (else the librarian PTY is killed + relaunched) and be single-owner-gated for tear-off. Lazy for the
// on-first-open chunk load.
const AlgorithmsPage = lazy(() => import("@/features/algorithms").then((m) => ({ default: m.AlgorithmsWorkspace })));

export function ProjectsWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  // Re-resolve the active project's repos + plan on tab open / project change.
  useProjectScan();

  const {
    projectsPageMode,
    setProjectsPageMode,
    projectsView,
    activeProjectId,
    planningPitch,
    planningTitle,
    planningSessionKey,
    activeStudioTargets,
  } = useAppStore();

  // The page modes ride the shared <Screen> shell (#1876), store-controlled so the tab bar and
  // the bodies share one source of truth — the same pattern the GitHub board uses (#499). usePageTabs
  // adds persisted order + per-mode tear-off into its own window (#430/#463).
  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("projects", PROJECT_MODES, {
    activeId: projectsPageMode,
    setActive: (id) => setProjectsPageMode(id as typeof projectsPageMode),
  });
  // A torn-off section window forces that one mode (and the bar is hidden).
  const mode = pageOverride ?? activeId;
  // Design Studio tear-off (#tearoff): "designs" drops out of the visible `tabs` while it's torn into
  // its own window. The main window then RELEASES the page (unmounts it, below) so the detached window
  // is the SOLE owner of the single designer PTY — the two never fight over pty_create/pty_kill.
  const designDetached = !tabs.some((t) => t.id === "designs");
  // Algorithms tear-off (#2827) — same single-owner handoff as Designs: the "algorithms" tab hosts the
  // always-on librarian PTY (#2787), so exactly one window mounts it at a time. When it's torn off it
  // drops from the main window's `tabs`, which releases the kept-mounted page (below) for the detached one.
  const algorithmsDetached = !tabs.some((t) => t.id === "algorithms");

  // Single source of truth for the session identity, frozen at session start.
  // Remounting Planning only when this changes means publish assigning a project
  // id (or a title edit) no longer tears down the active session. Every entry path
  // sets `planningSessionKey` to the name-derived key (#2409) — no alias resolution;
  // the fallbacks keep older in-flight sessions working if the key was never set.
  const planningKey = planningSessionKey || activeProjectId || `${planningTitle}::${planningPitch}`;

  // #3280 local-first: GitHub is OPTIONAL. The Planner opens with no connection — you draft, commit the
  // plan to plan.db, and launch the fleet offline; publishing to GitHub is an optional step when
  // connected. (Was a hard `!githubConnected → ProjectsEmpty` wall; the ProjectsList degrades on its own
  // — drafts + local-committed projects render, GitHub board data just isn't merged in.)

  return (
    <Screen
      className="projects-workspace"
      bodyClassName="projects-body"
      tabs={tabs}
      active={mode}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
    >
      {/* Fleet analytics moved to Glance (#2223/#2228). The console fleet launch (fleetStartProject) is
          unaffected — that's a separate build-tab flow, not this page mode. */}

      {/* Teams — the persona-relationship graph (#2193); also the persona editor (the Personas tab was
          folded in here, #2199). Authoring, not a live PTY, so torn-off windows never force this mode. */}
      {mode === "teams" && !pageOverride && (
        <Stack style={{ flex: 1, minHeight: 0 }}>
          <TeamsPanel />
        </Stack>
      )}

      {/* Sounds — the synthesis-first audio library (#3072). Authoring/preview, no live PTY (like Teams),
          so it renders directly (no keep-mounted / single-owner tear-off dance). */}
      {mode === "sounds" && (
        <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <SoundsWorkspace />
        </Box>
      )}

      {/* Planner — kept MOUNTED (CSS-hidden) in the main window so the live planning PTY survives a
          mode switch. A torn-off projects section shows just the list (a live planning PTY can't
          follow into a second window, #430/#463). */}
      {(!pageOverride || pageOverride === "projects") && (
        <Box style={{ display: mode === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
          {pageOverride ? (
            // #3874: Projects renders FROM THE GRAPH (the `projectspage` node) — here on the tear-off
            // path and below on the normal one. See ProjectsGraphHost.tsx.
            <ProjectsGraphHost />
          ) : (
            <>
              {/* Planning — mounted once on first visit, then CSS-hidden (not lazy → no fallback) */}
              <KeptMountedPage active={projectsView === "planning"}>
                <Planning key={planningKey} visible={projectsView === "planning"} />
              </KeptMountedPage>
              <Box style={{ display: projectsView !== "planning" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
                <ProjectsGraphHost />
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Design Studio (#move-to-planner) — the folded-in page, and it can TEAR OFF (#tearoff). Exactly
          ONE window mounts it at a time so they never fight over the single designer PTY: the detached
          window (pageOverride==="designs") owns it while torn off; otherwise the main window keeps it
          mounted (CSS-hidden) so the PTY survives a page switch, releasing it (designDetached) for the
          detached window. pty_create reconnects to a live session and `claude --continue` rehydrates a
          killed one, so the handoff is seamless either way. */}
      {pageOverride === "designs" && (
        <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Suspense fallback={<Box style={{ flex: 1 }} />}><DesignsWorkbenchPage /></Suspense>
        </Box>
      )}
      <KeptMountedPage
        active={mode === "designs"}
        gate={!pageOverride && !designDetached}
        keepAlive={activeStudioTargets.includes("designer")}
        fallback={<Box style={{ flex: 1 }} />}
        style={{ flexDirection: "row" }}
      >
        <DesignsWorkbenchPage />
      </KeptMountedPage>

      {/* Algorithms (#2785) — the knowledge graph, and it docks the always-on librarian session (#2787),
          so it gets the SAME keep-mounted + single-owner treatment as Designs (#2827): exactly one window
          mounts it at a time so they never fight over the single librarian PTY. The detached window
          (pageOverride==="algorithms") owns it while torn off; otherwise the main window keeps it mounted
          (CSS-hidden) so the PTY survives a page switch, releasing it (algorithmsDetached) for the detached
          window. pty_create reconnects to a live session and `claude --continue` rehydrates a killed one. */}
      {pageOverride === "algorithms" && (
        <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Suspense fallback={<Box style={{ flex: 1 }} />}><AlgorithmsPage /></Suspense>
        </Box>
      )}
      <KeptMountedPage
        active={mode === "algorithms"}
        gate={!pageOverride && !algorithmsDetached}
        keepAlive={activeStudioTargets.includes("librarian")}
        fallback={<Box style={{ flex: 1 }} />}
        style={{ flexDirection: "row" }}
      >
        <AlgorithmsPage />
      </KeptMountedPage>
    </Screen>
  );
}
