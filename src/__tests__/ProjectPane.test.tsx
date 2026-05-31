import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectPane } from "../screens/projects/ProjectPane";

describe("ProjectPane", () => {
  it("renders all four sections", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Project Files")).toBeTruthy();
    expect(screen.getByText("Agent Permissions")).toBeTruthy();
    expect(screen.getByText("Repository")).toBeTruthy();
    expect(screen.getByText("GitHub Structure")).toBeTruthy();
  });

  it("shows the permission presets and per-capability tri-state", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Balanced")).toBeTruthy();
    expect(screen.getByText("Read files")).toBeTruthy();
    expect(screen.getAllByText("Allow").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Deny").length).toBeGreaterThan(0);
  });

  it("renders the repository tree with the seeded-open directories", () => {
    render(<ProjectPane />);
    expect(screen.getByText("session.ts")).toBeTruthy();
  });

  it("renders the GitHub structure: milestones and their epics", () => {
    render(<ProjectPane />);
    // the first milestone is open by default, so its name + epics are visible
    expect(screen.getByText("Phase 1 - Auth foundation")).toBeTruthy();
    expect(screen.getByText("Magic-link sign-in")).toBeTruthy();
  });
});
