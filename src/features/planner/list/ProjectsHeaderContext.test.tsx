import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsHeader } from "./ProjectsHeader";
import type { ActiveProjectInfo } from "./ProjectsHeader";
import { useAppStore } from "@/store";

const project: ActiveProjectInfo = {
  id: "PVT_1", number: 7, name: "My App", repo: "o/a", repos: [], description: "",
};

describe("ProjectsHeader (GitHub board header, #499)", () => {
  beforeEach(() => {
    useAppStore.setState({ githubBoardOpen: true, githubBoardTab: "board" });
  });

  it("shows the published board tabs + a back-to-portfolio link", () => {
    render(<ProjectsHeader project={project} />);
    expect(screen.getByRole("button", { name: "Back to portfolio" })).toBeTruthy();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Roadmap")).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("Insights")).toBeTruthy();
    // The removed execution tabs are gone (#499).
    expect(screen.queryByText("Coordination")).toBeNull();
    expect(screen.queryByText("Pipelines")).toBeNull();
    expect(screen.queryByText("Hooks")).toBeNull();
  });

  it("offers the plan jump", () => {
    render(<ProjectsHeader project={project} />);
    expect(screen.getByText("⌘ plan →")).toBeTruthy();
  });
});
