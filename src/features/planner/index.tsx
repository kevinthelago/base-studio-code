import { useRef } from "react";
import { useAppStore } from "@/store";
import { Screen } from "@/app/chrome/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { ProjectsEmpty } from "./list/Empty";
import { ProjectsList } from "./list/ProjectsList";
import { Planning } from "./session/Planning";
import { OrgPanel } from "@/features/org";
import { useProjectScan } from "./list/useProjectScan";
import { PROJECT_MODES } from "./list/projectModes";
import "./projectsScreen.css";

// #1545: public API for cross-feature consumers. tunnel reaches plannerCore for CanonicalFile;
// components reaches the gist manifest/publish helpers (included for barrel completeness).
export type { CanonicalFile } from "./lib/plannerCore";
export {
  validateManifest, wrapExtension, encodeShareCode, decodeShareCode,
  type ExtensionManifest, type ValidateResult,
} from "./lib/gist/manifest";
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
export {
  decideDirectorAction, resolveDirectorDrive, askKey, pendingAskPrompt,
  briefKey, pendingBriefPrompt, DEFAULT_HEARTBEAT_MS, INJECT_COOLDOWN_MS,
} from "./fleet/directorDrive";

export function ProjectsWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  // Re-resolve the active project's repos + plan on tab open / project change.
  useProjectScan();

  const {
    githubConnected,
    projectsPageMode,
    setProjectsPageMode,
    projectsView,
    activeProjectId,
    planningPitch,
    planningTitle,
    planningSessionKey,
    projectKeyAlias,
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

  const planningEverShown = useRef(false);
  if (projectsView === "planning") planningEverShown.current = true;

  // Single source of truth for the session identity, frozen at session start.
  // Remounting Planning only when this changes means publish assigning a project
  // id (or a title edit) no longer tears down the active session. Fallback keeps
  // older sessions working if the key was never set.
  const rawPlanningKey = planningSessionKey || activeProjectId || `${planningTitle}::${planningPitch}`;
  const planningKey = projectKeyAlias[rawPlanningKey] ?? rawPlanningKey;

  // Not connected (main window only): the connect prompt owns the whole screen, no tabs. A detached
  // section window still renders its body (it shares the connected store).
  if (!githubConnected && !pageOverride) {
    return (
      <Stack style={{ flex: 1, minHeight: 0 }}>
        <ProjectsEmpty />
      </Stack>
    );
  }

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

      {/* Org — the persona-relationship graph (#2193); also the persona editor (the Personas tab was
          folded in here, #2199). Authoring, not a live PTY, so torn-off windows never force this mode. */}
      {mode === "org" && !pageOverride && (
        <Stack style={{ flex: 1, minHeight: 0 }}>
          <OrgPanel />
        </Stack>
      )}

      {/* Planner — kept MOUNTED (CSS-hidden) in the main window so the live planning PTY survives a
          mode switch. A torn-off projects section shows just the list (a live planning PTY can't
          follow into a second window, #430/#463). */}
      {(!pageOverride || pageOverride === "projects") && (
        <Box style={{ display: mode === "projects" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
          {pageOverride ? (
            <ProjectsList />
          ) : (
            <>
              {/* Planning — mounted once on first visit, then CSS-hidden */}
              {planningEverShown.current && (
                <Box style={{ display: projectsView === "planning" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
                  <Planning key={planningKey} visible={projectsView === "planning"} />
                </Box>
              )}
              <Box style={{ display: projectsView !== "planning" ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
                <ProjectsList />
              </Box>
            </>
          )}
        </Box>
      )}
    </Screen>
  );
}
