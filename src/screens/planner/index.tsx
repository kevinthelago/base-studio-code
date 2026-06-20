import { useRef } from "react";
import { useAppStore } from "../../store";
import { ProjectsEmpty } from "./Empty";
import { ProjectsList } from "./ProjectsList";
import { Planning } from "./Planning";
import { ProjectsPageModeStrip } from "./ProjectsSummary";
import { Fleet } from "./Fleet";
import { BlueprintsPage } from "./blueprints/BlueprintsPage";
import { DataModelsPage } from "./DataModelsPage";
import { useProjectScan } from "./useProjectScan";

export function ProjectsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  // Re-resolve the active project's repos + plan on tab open / project change.
  useProjectScan();

  const {
    githubConnected,
    projectsPageMode,
    projectsView,
    activeProjectId,
    planningPitch,
    planningTitle,
    planningSessionKey,
    projectKeyAlias,
  } = useAppStore();

  const planningEverShown = useRef(false);
  if (projectsView === "planning") planningEverShown.current = true;

  // Single source of truth for the session identity, frozen at session start.
  // Remounting Planning only when this changes means publish assigning a project
  // id (or a title edit) no longer tears down the active session. Fallback keeps
  // older sessions working if the key was never set.
  const rawPlanningKey = planningSessionKey || activeProjectId || `${planningTitle}::${planningPitch}`;
  const planningKey = projectKeyAlias[rawPlanningKey] ?? rawPlanningKey;

  // A torn-off tab (#430/#463): render just that one section, no mode strip. The
  // Planner tab detaches to the project list (a live planning PTY can't follow into
  // a second window); the rest map straight to their pages.
  if (sectionOverride) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {sectionOverride === "fleet" ? <Fleet />
          : sectionOverride === "blueprints" ? <BlueprintsPage />
          : sectionOverride === "dataModels" ? <DataModelsPage />
          : <ProjectsList />}
      </div>
    );
  }

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

      {/* Fleet — live orchestration; the worker board opens a per-agent page (#499). */}
      {projectsPageMode === "fleet" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Fleet />
        </div>
      )}

      {/* Blueprints — planning-stage presets; the active one seeds new projects (#513). */}
      {projectsPageMode === "blueprints" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <BlueprintsPage />
        </div>
      )}

      {/* Data Models — canonical schemas the data blueprints map into (#780). */}
      {projectsPageMode === "dataModels" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <DataModelsPage />
        </div>
      )}

      {/* Projects views — kept mounted via CSS when in list so the Planning PTY survives */}
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
          <ProjectsList />
        </div>
      </div>
    </div>
  );
}
