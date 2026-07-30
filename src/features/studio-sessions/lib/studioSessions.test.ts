import { describe, it, expect } from "vitest";
import {
  STUDIO_IDS, STUDIO_SESSIONS, STUDIO_INIT_CMD,
  STUDIO_RESUME_LOG, isStudioId, studioForPaneId, studioDetached,
} from "./studioSessions";
import { studioPageShowing } from "../useStudioPageShowing";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";
import { restrictedRoleCommands, isRestrictedRole, roleCapability, roleDeniedTools } from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS } from "@/features/personas";

describe("studio session registry (#3357)", () => {
  it("covers exactly the five page-docked app-owned studios, each on a stable systemSessions id", () => {
    expect(STUDIO_IDS).toEqual(["designer", "librarian", "architect", "soundDesigner", "integrator"]);
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

  // #4023 — the Integration Studio, pinned the same way and for the same reasons. `dirKey` must match
  // the Rust `IntegratorWorkspacePaths` field VERBATIM (Tauri does not rename return-value fields, so a
  // typo yields undefined and the session launches with no cwd).
  it("wires the integration studio to its own workspace, persona and role", () => {
    const def = STUDIO_SESSIONS.integrator;
    expect(def.paneId).toBe("integration-studio:integrator");
    expect(def.role).toBe("integrator");
    expect(def.setupCommand).toBe("setup_integrator_workspace");
    expect(def.dirKey).toBe("integrations_dir");
    expect(def.personaId).toBe("persona-integrator");
    expect(def.sectionId).toBe("integrations");
  });

  // The studio ships with its procedure attached rather than re-deriving it per conversation (#3766's
  // pattern): the skill is PINNED, so a restricted session gets exactly it and not the global firehose.
  it("pins the build-integration skill onto the integrator", () => {
    expect(STUDIO_SESSIONS.integrator.defaultSkillIds).toEqual(["build-integration"]);
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

  // #3374: the init command used to be `claude --continue 2>/dev/null || claude`, which DISCARDED the
  // reason a resume failed and degraded silently — a session that failed to resume was indistinguishable
  // from one that had never run. That is why studios starting fresh across restarts could not be
  // diagnosed: the only signal that would explain it was thrown away on every launch.
  it("never discards why a resume failed, and announces the fallback", () => {
    expect(STUDIO_INIT_CMD).not.toContain("2>/dev/null");
    // stderr is APPENDED (not truncated) so successive attempts accumulate rather than overwrite.
    expect(STUDIO_INIT_CMD).toContain(`2>>`);
    expect(STUDIO_INIT_CMD).toContain(STUDIO_RESUME_LOG);
    // The user can tell from the pane that they are starting over, not silently continuing.
    expect(STUDIO_INIT_CMD).toContain("starting fresh");
  });

  it("still resumes first and falls back to a fresh session — behaviour is unchanged", () => {
    expect(STUDIO_INIT_CMD.startsWith("claude --continue")).toBe(true);
    expect(STUDIO_INIT_CMD).toContain("||");
    // The fallback is a bare `claude`, not another --continue (which would fail identically).
    expect(/claude;/.test(STUDIO_INIT_CMD)).toBe(true);
  });

  // A missing log dir must never stop a session launching — the diagnostic is best-effort.
  it("guards an unset $BSC_LOG_DIR rather than writing to a bare path", () => {
    expect(STUDIO_INIT_CMD).toContain("${BSC_LOG_DIR:-/tmp}");
  });

  // #4023: the integrator is the ONE studio allowed on the network, because it cannot author a manifest
  // for an API it may not read about. That widening must be exactly one axis wide — if a future edit
  // hands it git, GitHub, code or a UI grant, this fails.
  it("lets ONLY the integrator reach the web, and widens nothing else for it", () => {
    const netByStudio = Object.fromEntries(
      STUDIO_IDS.map((id) => [id, roleCapability(STUDIO_SESSIONS[id].role).net]),
    );
    expect(netByStudio).toEqual({
      designer: "none", librarian: "none", architect: "none", soundDesigner: "none",
      integrator: "read",
    });
    const cap = roleCapability("integrator");
    expect([cap.github, cap.git, cap.code, cap.ui]).toEqual(["none", "none", "none", "none"]);
    // `net: read` is what leaves the web tools available — the gate denies them at `none` (#1107).
    expect(roleDeniedTools(cap)).not.toContain("WebFetch");
    expect(roleDeniedTools(roleCapability("librarian"))).toContain("WebFetch");
  });

  // Its whole auto-run surface is the connector CLI. `bsc data connector` is ONE prefix covering both the
  // store verbs and the probe/validate/try/map dev-loop, so nothing broader (`bsc data`, or a bare `bsc`)
  // may appear — that would hand a confined session the DuckDB model and every other store.
  it("confines the integrator to the connector CLI and nothing wider", () => {
    const cmds = restrictedRoleCommands("integrator");
    expect(cmds).toContain("bsc data connector");
    expect(cmds).not.toContain("bsc data");
    expect(cmds).not.toContain("bsc");
    expect(isRestrictedRole("integrator")).toBe(true); // ⇒ the bypass posture cannot widen it
  });

  // `personaId` is load-bearing and fails SILENTLY: its `startPrompt` is baked in as
  // `claude --initial-message`, so a typo yields no initial message and a studio that sits there with no
  // instructions — indistinguishable from a session that simply hasn't been asked anything yet.
  it("resolves every studio's persona, and its role agrees with the studio's", () => {
    for (const id of STUDIO_IDS) {
      const def = STUDIO_SESSIONS[id];
      const persona = BUILTIN_PERSONAS.find((p) => p.id === def.personaId);
      expect(persona, `${id} → ${def.personaId} resolves to a built-in persona`).toBeTruthy();
      expect(persona!.role).toBe(def.role);
      expect(persona!.startPrompt.trim().length).toBeGreaterThan(200);
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
