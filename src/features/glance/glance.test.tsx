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

  it("opens the Network page by default, ALWAYS rendering the graph — never a blocking empty-state page (#3033)", () => {
    render(<GlanceWorkspace />);
    // With no projects we render the (empty) project-network graph + its toolbar, NOT the old
    // "No project network yet" empty-state page (#2272 reverted by #3033).
    expect(screen.queryByText("No project network yet")).toBeNull();
    expect(screen.getByText("fit")).toBeTruthy();       // the graph toolbar rendered → the canvas is present
    expect(screen.getByText("Load demo")).toBeTruthy(); // the demo affordance moved into the toolbar when empty
  });

  it("renders only the active page body (Fleet is not mounted on the Network tab)", () => {
    render(<GlanceWorkspace />);
    // The Fleet dashboard's worker board only mounts on the Fleet tab.
    expect(screen.queryByText("Worker board")).toBeNull();
  });
});
