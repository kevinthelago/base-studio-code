import { useRef } from "react";
import { useAppStore } from "@/store";
import { Screen } from "@/app/chrome/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { ProjectsEmpty } from "./list/Empty";
import { ProjectsList } from "./list/ProjectsList";
import { Planning } from "./session/Planning";
import { Fleet } from "./fleet/Fleet";
import { PersonasPanel } from "@/features/personas";
import { OrgPanel } from "@/features/org";
import { useProjectScan } from "./list/useProjectScan";
import { PROJECT_MODES } from "./list/projectModes";
import "./projectsScreen.css";

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
      {/* Fleet — live orchestration; the worker board opens a per-agent page (#499). Mounts on demand. */}
      {mode === "fleet" && (
        <Stack style={{ flex: 1, minHeight: 0 }}>
          <Fleet />
        </Stack>
      )}

      {/* Personas — the CRUD-able agent-identity library (#2094). Mounts on demand. Torn-off section
          windows never force this mode (it's authoring, not a live PTY). */}
      {mode === "personas" && !pageOverride && (
        <Stack style={{ flex: 1, minHeight: 0 }}>
          <PersonasPanel />
        </Stack>
      )}

      {/* Org — the persona-relationship graph (#2193). Authoring, not a live PTY, so torn-off windows
          never force this mode. Mounts on demand. */}
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
