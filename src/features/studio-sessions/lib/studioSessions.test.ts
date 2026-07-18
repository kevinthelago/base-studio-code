import { describe, it, expect } from "vitest";
import {
  STUDIO_IDS, STUDIO_SESSIONS, STUDIO_INIT_CMD, isStudioId, studioForPaneId, studioDetached,
} from "./studioSessions";
import { studioPageShowing } from "../useStudioPageShowing";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";
import { restrictedRoleCommands } from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS } from "@/features/personas";

describe("studio session registry (#3357)", () => {
  it("covers exactly the three page-docked app-owned studios, each on a stable systemSessions id", () => {
    expect(STUDIO_IDS).toEqual(["designer", "librarian", "architect"]);
    for (const id of STUDIO_IDS) {
      const def = STUDIO_SESSIONS[id];
      expect(def.id).toBe(id);
      // The pane id must be one systemSessions knows, so crash recovery keeps excluding it (#3137).
      expect(isStudioSessionPaneId(def.paneId)).toBe(true);
      expect(studioForPaneId(def.paneId)).toBe(id);
    }
  });

  it("gives every studio a RESTRICTED role — the whole confinement derives from this one field", () => {
    // `buildSessionSettings` reads `paneRoles[paneId]` and computes the session's entire auto-run surface
    // from it. A role with no restricted command set would silently launch with the broad baselines.
    for (const id of STUDIO_IDS) {
      expect(restrictedRoleCommands(STUDIO_SESSIONS[id].role).length).toBeGreaterThan(0);
    }
  });

  it("points every studio at a persona that actually exists (the baked kickoff would be empty otherwise)", () => {
    for (const id of STUDIO_IDS) {
      expect(BUILTIN_PERSONAS.some((p) => p.id === STUDIO_SESSIONS[id].personaId)).toBe(true);
    }
  });

  it("resumes the prior conversation on every launch (stable pane id + claude --continue)", () => {
    expect(STUDIO_INIT_CMD).toContain("claude --continue");
  });

  it("isStudioId narrows only the three studio ids (a Glance node id is an arbitrary string)", () => {
    expect(isStudioId("designer")).toBe(true);
    for (const other of ["debugger", "library", "planner", "director", "", null, undefined]) {
      expect(isStudioId(other)).toBe(false);
    }
    expect(studioForPaneId("proj:api")).toBeNull();
  });

  it("studioDetached reports the single-owner handoff — the main window must release a torn-off studio", () => {
    expect(studioDetached("designer", {})).toBe(false);
    expect(studioDetached("designer", { projects: ["designs"] })).toBe(true);
    // Scoped per section: tearing off Algorithms leaves the designer mounted here.
    expect(studioDetached("designer", { projects: ["algorithms"] })).toBe(false);
    expect(studioDetached("librarian", { projects: ["algorithms"] })).toBe(true);
  });
});

describe("studioPageShowing (#3357)", () => {
  // The studio pages are KEPT MOUNTED and merely CSS-hidden, so "mounted" is not "on screen" — if the
  // viewer count keyed off mounting it would never fall to 0 after a first visit and the reaper could
  // never fire. This is the rule that makes leaving the page actually count as leaving.
  it("is true only while its page is the active Projects page", () => {
    expect(studioPageShowing("designer", { activeWorkspace: "projects", projectsPageMode: "designs" }, null)).toBe(true);
    expect(studioPageShowing("designer", { activeWorkspace: "projects", projectsPageMode: "teams" }, null)).toBe(false);
    // Kept mounted but the user is on another WORKSPACE (Glance/Console) → not showing.
    expect(studioPageShowing("designer", { activeWorkspace: "glance", projectsPageMode: "designs" }, null)).toBe(false);
  });

  it("maps each studio to its own page", () => {
    const at = (mode: string) => ({ activeWorkspace: "projects", projectsPageMode: mode });
    expect(studioPageShowing("librarian", at("algorithms"), null)).toBe(true);
    expect(studioPageShowing("architect", at("teams"), null)).toBe(true);
    expect(studioPageShowing("librarian", at("teams"), null)).toBe(false);
  });

  it("a torn-off section window is showing exactly the page it was detached for", () => {
    const bg = { activeWorkspace: "glance", projectsPageMode: "projects" };
    expect(studioPageShowing("designer", bg, { page: "projects", section: "designs" })).toBe(true);
    expect(studioPageShowing("librarian", bg, { page: "projects", section: "designs" })).toBe(false);
  });
});
