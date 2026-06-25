import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsPageModeStrip } from "./ProjectsSummary";

describe("ProjectsPageModeStrip (#548)", () => {
  it("renders the mode tabs", () => {
    render(<ProjectsPageModeStrip />);
    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("Fleet")).toBeTruthy();
    expect(screen.getByText("Data Models")).toBeTruthy();
    // The Blueprints page-mode was folded into the Planner tab's blueprint rail (#blueprints).
    expect(screen.queryByText("Blueprints")).toBeNull();
  });

  it("no longer renders the fake '● github sync' indicator (#548)", () => {
    render(<ProjectsPageModeStrip />);
    expect(screen.queryByText(/github sync/)).toBeNull();
  });
});
