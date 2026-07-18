import { describe, it, expect } from "vitest";
import {
  STUDIO_IDS, STUDIO_SESSIONS, STUDIO_INIT_CMD, isStudioId, studioForPaneId, studioDetached,
} from "./studioSessions";
import { studioPageShowing } from "../useStudioPageShowing";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";
import { restrictedRoleCommands } from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS } from "@/features/personas";

describe("studio session registry (#3357)", () => {
  it("covers exactly the four page-docked app-owned studios, each on a stable systemSessions id", () => {
    expect(STUDIO_IDS).toEqual(["designer", "librarian", "architect", "soundDesigner"]);
    for (const id of STUDIO_IDS) {
      const def = STUDIO_SESSIONS[id];
      expect(def.id).toBe(id);
      // The pane id must be one systemSessions knows, so crash recovery keeps excluding it (#3137).
      expect(isStudioSessionPaneId(def.paneId)).toBe(true);
      expect(studioForPaneId(def.paneId)).toBe(id);
    }
  });

  // #3369 (epic #3071 phase 4) — the Sound Studio's wiring, pinned field by field. Every one of these
  // is load-bearing at launch: the setup command resolves the cwd (an empty cwd would launch the session
  // permission-less, #1819), `dirKey` must match the Rust struct field VERBATIM (Tauri does not rename
  // return-value fields, so a typo silently yields undefined), and the role is the whole confinement.
  it("wires the sound studio to its own workspace, persona and role", () => {
    const def = STUDIO_SESSIONS.soundDesigner;
    expect(def.paneId).toBe("sound-studio:sound-designer");
    expect(def.role).toBe("sound-designer");
    expect(def.setupCommand).toBe("setup_sound_designer_workspace");
    expect(def.dirKey).toBe("sound_dir");
    expect(def.personaId).toBe("persona-sound-designer");
    expect(def.sectionId).toBe("sounds");
  });

  // The role name overlaps the designer's; the SESSIONS must stay wholly separate or opening one would
  // reuse the other's terminal (they key off paneId) or its permission surface.
  it("keeps the sound studio distinct from the Design Studio in every identifying field", () => {
    const sound = STUDIO_SESSIONS.soundDesigner, design = STUDIO_SESSIONS.designer;
    expect(sound.paneId).not.toBe(design.paneId);
    expect(sound.role).not.toBe(design.role);
    expect(sound.setupCommand).not.toBe(design.setupCommand);
    expect(sound.dirKey).not.toBe(design.dirKey);
    expect(sound.personaId).not.toBe(design.personaId);
    expect(sound.sectionId).not.toBe(design.sectionId);
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
