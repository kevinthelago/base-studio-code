import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsHeader } from "../../screens/projects/ProjectsHeader";
import type { ActiveProjectInfo } from "../../screens/projects/ProjectsHeader";
import { useAppStore } from "../../store";

const project: ActiveProjectInfo = {
  id: "PVT_1", number: 7, name: "My App", repo: "o/a", repos: [], description: "",
};

describe("ProjectsHeader · context (#498)", () => {
  beforeEach(() => {
    useAppStore.setState({ githubBoardOpen: true, githubBoardTab: "board" });
  });

  it("github context shows the published board tabs + a back-to-portfolio link", () => {
    render(<ProjectsHeader project={project} context="github" />);
    expect(screen.getByText("← portfolio")).toBeTruthy();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Roadmap")).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("Insights")).toBeTruthy();
    // The execution tabs are NOT on the GitHub board.
    expect(screen.queryByText("Coordination")).toBeNull();
    expect(screen.queryByText("Pipelines")).toBeNull();
  });

  it("projects context shows the execution tabs + a back-to-projects link", () => {
    render(<ProjectsHeader project={project} context="projects" />);
    expect(screen.getByText("← projects")).toBeTruthy();
    expect(screen.getByText("Coordination")).toBeTruthy();
    expect(screen.getByText("Pipelines")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    // The GitHub-published views are NOT on the Projects page header.
    expect(screen.queryByText("Board")).toBeNull();
    expect(screen.queryByText("Insights")).toBeNull();
  });
});
