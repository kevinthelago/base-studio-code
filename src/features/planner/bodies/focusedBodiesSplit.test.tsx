import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FocusedReposBody } from "./FocusedReposBody";
import { FocusedContextBody } from "./FocusedContextBody";
import { FocusedSkillsBody } from "./FocusedSkillsBody";

// Smoke tests for bodies extracted from FocusedBodies.tsx (#1757) — confirm the moved files
// render standalone (imports resolve) for the empty + populated cases.
describe("extracted focused bodies render standalone", () => {
  it("FocusedReposBody shows the empty state with no repos", () => {
    render(<FocusedReposBody />);
    expect(screen.getByText("No repositories linked yet")).toBeTruthy();
  });

  it("FocusedReposBody lists linked repos", () => {
    render(<FocusedReposBody repos={[{ id: "o/app", branch: "main", ahead: 0, behind: 0, agents: [], primary: false, branches: [] }]} />);
    expect(screen.getByText("o/app")).toBeTruthy();
  });

  it("FocusedContextBody shows the empty state with no files", () => {
    render(<FocusedContextBody />);
    expect(screen.getByText("No context files yet")).toBeTruthy();
  });

  it("FocusedSkillsBody shows the empty state with no skills", () => {
    render(<FocusedSkillsBody />);
    expect(screen.getByText("No skills attached")).toBeTruthy();
  });
});
