import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "@/features/planner/list/projectModes";

// #421: the Projects portfolio summary moved into the GitHub screen, between
// Summary and Repositories. The Projects tab drops its Summary mode.

// COVERAGE LOST HERE: a "GitHub mode strip" case rendered GitHubPageModeStrip and asserted its options
// were Summary · Projects · Repositories in that order. Its file went with the code-fallback cut — the
// `github-page-mode-strip` record is the only copy now, and a record carries no runnable test. The
// PROJECT_MODES half below is unaffected: it reads a plain data table, not the deleted component.

describe("Projects modes (#1876)", () => {
  it("no longer offers Summary, and keeps Projects — the one page the Planner is for", () => {
    const labels = PROJECT_MODES.map((m) => m.label);
    expect(labels).not.toContain("Summary");
    expect(labels).toContain("Projects");
    expect(labels).not.toContain("Fleet");
    expect(labels).not.toContain("Personas");
    // Teams was a Planner tab (#2199/#2700) until `five-graphs-become-rail-workspaces` gave it its
    // own rail destination — it is asserted as a live Workspace in projectsPageModeStrip.test.tsx,
    // which is where "it moved rather than vanished" belongs.
    expect(labels).not.toContain("Teams");
  });
});
