// App-owned studio sessions (#3137) — the recovery-exclusion source of truth.
import { describe, it, expect } from "vitest";
import {
  isStudioSessionPaneId,
  isFullCapabilitySession,
  STUDIO_SESSION_PANE_IDS,
  DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID,
  TEAMS_STUDIO_SESSION_ID,
  DEBUG_STUDIO_SESSION_ID,
} from "./systemSessions";

describe("isStudioSessionPaneId (#3137)", () => {
  it("matches each app-owned studio session id", () => {
    for (const id of [DESIGN_STUDIO_SESSION_ID, ALGORITHMS_STUDIO_SESSION_ID, TEAMS_STUDIO_SESSION_ID, DEBUG_STUDIO_SESSION_ID]) {
      expect(isStudioSessionPaneId(id)).toBe(true);
    }
    expect(STUDIO_SESSION_PANE_IDS).toContain("design-studio:designer");
    expect(STUDIO_SESSION_PANE_IDS).toContain("algorithms-studio:librarian");
    expect(STUDIO_SESSION_PANE_IDS).toContain("teams-studio:architect");
    expect(STUDIO_SESSION_PANE_IDS).toContain("debug-studio:debugger");
  });

  it("does NOT match real fleet / manual / planner ids (they share the `<key>:<tail>` shape)", () => {
    for (const id of ["proj:auth", "proj:director", "own/web:triage", "man:scratch:p0", "planning_proj", "garbage"]) {
      expect(isStudioSessionPaneId(id)).toBe(false);
    }
  });

  it("is exactly the four studios (a new studio must be added here to be excluded)", () => {
    expect([...STUDIO_SESSION_PANE_IDS].sort()).toEqual(
      ["algorithms-studio:librarian", "debug-studio:debugger", "design-studio:designer", "teams-studio:architect"],
    );
  });
});

describe("isFullCapabilitySession (#3326)", () => {
  it("is true ONLY for the debug session — the always-bypass carve-out", () => {
    expect(isFullCapabilitySession(DEBUG_STUDIO_SESSION_ID)).toBe(true);
  });

  it("is false for the other studios (they keep their bespoke launch postures)", () => {
    for (const id of [DESIGN_STUDIO_SESSION_ID, ALGORITHMS_STUDIO_SESSION_ID, TEAMS_STUDIO_SESSION_ID]) {
      expect(isFullCapabilitySession(id)).toBe(false);
    }
  });

  it("is false for fleet / manual / planner ids (they follow the global posture)", () => {
    for (const id of ["proj:auth", "proj:director", "own/web:triage", "man:scratch:p0", "planning_proj"]) {
      expect(isFullCapabilitySession(id)).toBe(false);
    }
  });
});
