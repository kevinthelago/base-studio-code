import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsPageModeStrip } from "../screens/projects/ProjectsSummary";

describe("ProjectsPageModeStrip (#548)", () => {
  it("renders the mode tabs", () => {
    render(<ProjectsPageModeStrip />);
    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("Fleet")).toBeTruthy();
    expect(screen.getByText("Blueprints")).toBeTruthy();
  });

  it("no longer renders the fake '● github sync' indicator (#548)", () => {
    render(<ProjectsPageModeStrip />);
    expect(screen.queryByText(/github sync/)).toBeNull();
  });
});
