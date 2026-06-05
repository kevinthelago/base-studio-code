import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectOverview } from "../screens/projects/ProjectOverview";
import { useAppStore } from "../store";

describe("ProjectOverview (#523)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeProjectId: "p1", activeProjectName: "My App", activeProjectRepo: "o/a",
      activeProjectRepos: ["o/a", "o/b"], activeProjectNumber: 5,
      githubBoardOpen: true, githubBoardTab: "overview",
    });
  });

  it("renders the project-home cards", () => {
    render(<ProjectOverview />);
    expect(screen.getByText("Repositories")).toBeTruthy();
    expect(screen.getByText("Project analytics")).toBeTruthy();
    expect(screen.getByText("Agent fleet")).toBeTruthy();
    expect(screen.getByText("Coordination")).toBeTruthy();
    // real repo list (also shown in the header strip, hence getAllByText)
    expect(screen.getAllByText("o/a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("o/b").length).toBeGreaterThan(0);
  });

  it("quick-nav switches the board sub-tab", () => {
    render(<ProjectOverview />);
    fireEvent.click(screen.getByText("Iteration burndown"));
    expect(useAppStore.getState().githubBoardTab).toBe("insights");
  });

  it("shows an honest empty state when no agents are live", () => {
    render(<ProjectOverview />);
    expect(screen.getByText(/No live agents for this project/)).toBeTruthy();
    expect(screen.getByText(/No blocked or waiting sessions/)).toBeTruthy();
  });
});
