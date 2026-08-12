import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "./projectModes";

// #421: the Projects portfolio summary moved into the GitHub screen, between
// Summary and Repositories. The Projects tab drops its Summary mode.

// COVERAGE LOST HERE: a "GitHub mode strip" case rendered GitHubPageModeStrip and asserted its options
// were Summary · Projects · Repositories in that order. Its file went with the code-fallback cut — the
// `github-page-mode-strip` record is the only copy now, and a record carries no runnable test. The
// PROJECT_MODES half below is unaffected: it reads a plain data table, not the deleted component.

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
