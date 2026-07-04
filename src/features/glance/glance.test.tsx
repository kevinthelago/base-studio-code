// GlanceWorkspace (#2223) — the tabbed mission-control Screen: Network (project graph) + Fleet.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceWorkspace } from "./GlanceWorkspace";

describe("GlanceWorkspace (tabbed, #2223)", () => {
  it("renders the Network and Fleet page tabs", () => {
    render(<GlanceWorkspace />);
    expect(screen.getByText("Network")).toBeTruthy();
    expect(screen.getByText("Fleet")).toBeTruthy();
  });

  it("opens the Network page by default, showing a REAL empty state when there are no projects (#2272)", () => {
    render(<GlanceWorkspace />);
    // With no projects, the Network page renders a real empty state — NOT the old sample/mock graph.
    expect(screen.getByText("No project network yet")).toBeTruthy();
    expect(screen.queryByText("PROJECTS")).toBeNull(); // the projects rail only shows once there are projects
  });

  it("renders only the active page body (Fleet is not mounted on the Network tab)", () => {
    render(<GlanceWorkspace />);
    // The Fleet dashboard's worker board only mounts on the Fleet tab.
    expect(screen.queryByText("Worker board")).toBeNull();
  });
});
