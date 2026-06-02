import { useRef } from "react";
import { useAppStore } from "../../store";
import { ProjectsEmpty } from "./Empty";
import { ProjectsList } from "./ProjectsList";
import { ProjectBoard } from "./ProjectBoard";
import { Roadmap } from "./Roadmap";
import { Issues } from "./Issues";
import { Insights } from "./Insights";
import { HooksView } from "./Hooks";
import { CoordinatorInbox } from "./CoordinatorInbox";
import { PipelinesLane } from "./PipelinesLane";
import { Planning } from "./Planning";
import { ProjectsSummary, ProjectsPageModeStrip } from "./ProjectsSummary";
import { Fleet } from "./Fleet";
import { useProjectScan } from "./useProjectScan";

export function ProjectsScreen() {
  // Re-resolve the active project's repos + plan on tab open / project change.
  useProjectScan();

  const {
    githubConnected,
    projectsPageMode,
    projectsView,
    projectsBoardTab,
    activeProjectId,
    planningPitch,
    planningTitle,
    planningSessionKey,
    projectKeyAlias,
  } = useAppStore();

  const planningEverShown = useRef(false);
  if (projectsView === "planning") planningEverShown.current = true;
  // Mount the summary once on first visit, then keep it mounted (CSS-hidden) so
  // returning to it doesn't remount + refetch — see the summary render below.
  const summaryEverShown = useRef(false);
  if (projectsPageMode === "summary") summaryEverShown.current = true;

  // Single source of truth for the session identity, frozen at session start.
  // Remounting Planning only when this changes means publish assigning a project
  // id (or a title edit) no longer tears down the active session. Fallback keeps
  // older sessions working if the key was never set.
  const rawPlanningKey = planningSessionKey || activeProjectId || `${planningTitle}::${planningPitch}`;
  const planningKey = projectKeyAlias[rawPlanningKey] ?? rawPlanningKey;

  if (!githubConnected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <ProjectsEmpty />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ProjectsPageModeStrip />

      {/* Summary — mounted once, then CSS-hidden, so revisiting doesn't remount +
          refetch (matches the Planning/projects views below). */}
      {summaryEverShown.current && (
        <div style={{
          display: projectsPageMode === "summary" ? "flex" : "none",
          flex: 1, flexDirection: "column", minHeight: 0,
        }}>
          <ProjectsSummary />
        </div>
      )}

      {/* Fleet — live orchestration analytics for the active project's agent fleet. */}
      {projectsPageMode === "fleet" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Fleet />
        </div>
      )}

      {/* Projects views — kept mounted via CSS when in summary so Planning PTY survives */}
      <div style={{
        display: projectsPageMode === "projects" ? "flex" : "none",
        flex: 1, flexDirection: "column", minHeight: 0,
      }}>
        {/* Planning — mounted once on first visit, then CSS-hidden */}
        {planningEverShown.current && (
          <div style={{
            display: projectsView === "planning" ? "flex" : "none",
            flex: 1, flexDirection: "column", minHeight: 0,
          }}>
            <Planning key={planningKey} visible={projectsView === "planning"} />
          </div>
        )}

        <div style={{
          display: projectsView !== "planning" ? "flex" : "none",
          flex: 1, flexDirection: "column", minHeight: 0,
        }}>
          {projectsView === "board" && projectsBoardTab === "roadmap"  && <Roadmap />}
          {projectsView === "board" && projectsBoardTab === "board"    && <ProjectBoard />}
          {projectsView === "board" && projectsBoardTab === "issues"   && <Issues />}
          {projectsView === "board" && projectsBoardTab === "insights" && <Insights />}
          {projectsView === "board" && projectsBoardTab === "hooks"    && <HooksView />}
          {projectsView === "board" && projectsBoardTab === "coordination" && <CoordinatorInbox />}
          {projectsView === "board" && projectsBoardTab === "pipelines" && <PipelinesLane />}
          {projectsView !== "board" && <ProjectsList />}
        </div>
      </div>
    </div>
  );
}
