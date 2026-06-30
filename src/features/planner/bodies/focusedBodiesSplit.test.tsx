import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiscoveryBody } from "./DiscoveryBody";
import { SkillsBody } from "./FocusedSkillsBody";

// Smoke tests for bodies extracted from FocusedBodies.tsx (#1757) — confirm the moved files render
// standalone (imports resolve) for the empty case. (The plain FocusedReposBody was removed with the
// link-only blueprints; the merged Repositories & Deployment pane is covered by ReposDeployView.test.)
describe("extracted focused bodies render standalone", () => {
  it("DiscoveryBody shows the empty state with no files", () => {
    render(<DiscoveryBody />);
    expect(screen.getByText("No context files yet")).toBeTruthy();
  });

  it("SkillsBody shows the empty state with no skills", () => {
    render(<SkillsBody />);
    expect(screen.getByText("No skills attached")).toBeTruthy();
  });
});
