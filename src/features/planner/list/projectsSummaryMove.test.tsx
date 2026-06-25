import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitHubPageModeStrip } from "@/features/github/GitHubSummary";
import { ProjectsPageModeStrip } from "./ProjectsSummary";

// #421: the Projects portfolio summary moved into the GitHub screen, between
// Summary and Repositories. The Projects tab drops its Summary mode.

describe("GitHub mode strip", () => {
  it("offers Summary · Projects · Repositories in that order", () => {
    const { container } = render(<GitHubPageModeStrip />);
    const labels = Array.from(container.querySelectorAll("div"))
      .map(d => d.childNodes[0]?.textContent?.trim())
      .filter(t => t === "Summary" || t === "Projects" || t === "Repositories");
    expect(labels).toEqual(["Summary", "Projects", "Repositories"]);
  });
});

describe("Projects mode strip", () => {
  it("no longer offers Summary — just Planner + Fleet", () => {
    render(<ProjectsPageModeStrip />);
    expect(screen.queryByText("Summary")).toBeNull();
    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("Fleet")).toBeTruthy();
  });
});
