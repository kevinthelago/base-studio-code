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

  it("opens the Network graph by default (the projects rail is present)", () => {
    render(<GlanceWorkspace />);
    expect(screen.getByText("PROJECTS")).toBeTruthy();
  });

  it("renders only the active page body (Fleet is not mounted on the Network tab)", () => {
    render(<GlanceWorkspace />);
    // The Fleet dashboard's worker board only mounts on the Fleet tab.
    expect(screen.queryByText("Worker board")).toBeNull();
  });
});
