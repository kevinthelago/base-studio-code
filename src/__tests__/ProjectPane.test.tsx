import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectPane } from "../screens/projects/ProjectPane";

describe("ProjectPane", () => {
  it("renders the three sections", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Project Files")).toBeTruthy();
    expect(screen.getByText("Agent Permissions")).toBeTruthy();
    expect(screen.getByText("Repository")).toBeTruthy();
  });

  it("shows the permission presets and per-capability tri-state", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Balanced")).toBeTruthy();
    expect(screen.getByText("Read files")).toBeTruthy();
    // every capability row renders Allow/Ask/Deny buttons
    expect(screen.getAllByText("Allow").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Deny").length).toBeGreaterThan(0);
  });

  it("renders the repository tree with the seeded-open directories", () => {
    render(<ProjectPane />);
    // src and src/auth open by default, so a nested file is visible
    expect(screen.getByText("session.ts")).toBeTruthy();
  });
});
