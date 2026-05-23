import { useAppStore } from "../../store";
import { ProjectsEmpty } from "./Empty";
import { ProjectsList } from "./ProjectsList";
import { ProjectBoard } from "./ProjectBoard";
import { Roadmap } from "./Roadmap";
import { Issues } from "./Issues";
import { Insights } from "./Insights";
import { Planning } from "./Planning";


export function ProjectsScreen() {
  const { githubConnected, projectsView, projectsBoardTab } = useAppStore();

  if (!githubConnected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <ProjectsEmpty />
      </div>
    );
  }

  if (projectsView === "planning") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Planning />
      </div>
    );
  }

  if (projectsView === "board") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {projectsBoardTab === "roadmap"  && <Roadmap />}
        {projectsBoardTab === "board"    && <ProjectBoard />}
        {projectsBoardTab === "issues"   && <Issues />}
        {projectsBoardTab === "insights" && <Insights />}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ProjectsList />
    </div>
  );
}
