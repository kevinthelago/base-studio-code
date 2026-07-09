import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GitHubPageModeStrip } from "@/features/github/GitHubSummary";
import { PROJECT_MODES } from "./projectModes";

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

describe("Projects modes (#1876)", () => {
  it("no longer offers Summary — Projects + Teams (Fleet→Glance #2228, Personas→Teams #2199)", () => {
    const labels = PROJECT_MODES.map((m) => m.label);
    expect(labels).not.toContain("Summary");
    expect(labels).toContain("Projects");
    // Personas was folded into the Teams page (#2199); Fleet analytics into Glance (#2223/#2228).
    expect(labels).toContain("Teams");
    expect(labels).not.toContain("Fleet");
    expect(labels).not.toContain("Personas");
  });
});
