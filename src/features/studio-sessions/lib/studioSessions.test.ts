import { describe, it, expect } from "vitest";
import {
  STUDIO_IDS, STUDIO_SESSIONS, STUDIO_INIT_CMD,
  STUDIO_RESUME_LOG, isStudioId, studioForPaneId, studioDetached,
} from "@/features/studio-sessions/lib/studioSessions";
import { studioPageShowing } from "@/features/studio-sessions/useStudioPageShowing";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";
import { WORKSPACES } from "@/app/registry";
import { restrictedRoleCommands, isRestrictedRole, roleCapability, roleDeniedTools } from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS } from "@/features/personas";

describe("studio session registry (#3357)", () => {
  it("covers exactly the page-docked app-owned studios, each on a stable systemSessions id", () => {
    // #system-sessions-are-per-technology: the librarian and designer are one session PER TECHNOLOGY
    // (their stores are partitioned); the architect, sound-designer and integrator stay single.
    expect(STUDIO_IDS).toEqual([
      "designerReact", "designerReactNative",
      "librarianRust", "librarianTypescript", "librarianPython",
      "architect", "soundDesigner", "integrator",
    ]);
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
    const sound = STUDIO_SESSIONS.soundDesigner, design = STUDIO_SESSIONS.designerReact;
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
      designerReact: "none", designerReactNative: "none",
      librarianRust: "none", librarianTypescript: "none", librarianPython: "none",
      architect: "none", soundDesigner: "none",
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

  it("isStudioId narrows only the studio ids (a Glance node id is an arbitrary string)", () => {
    for (const id of STUDIO_IDS) expect(isStudioId(id)).toBe(true);
    // The un-teched ROLE names are NOT studio ids since the per-technology split — `designer` is a
    // role and a Glance node id, never a session. Narrowing one would key store maps by a value that
    // resolves to no pane.
    for (const other of ["designer", "librarian", "debugger", "library", "planner", "director", "", null, undefined]) {
      expect(isStudioId(other)).toBe(false);
    }
    expect(studioForPaneId("proj:api")).toBeNull();
  });

  it("studioDetached reports the single-owner handoff — the main window must release a torn-off studio", () => {
    // The key is the studio's WORKSPACE now, not "projects"
    // (`five-graphs-become-rail-workspaces`). NOTE that nothing currently WRITES these keys: a
    // Workspace has no tab strip until the technology tabs land, so in practice this is uniformly
    // false and the main window is always the sole owner. That is safe — one owner, never two
    // fighting over one PTY — so tear-off is dormant rather than broken, and the mechanism stays
    // asserted here so restoring it is wiring, not rediscovery.
    expect(studioDetached("designerReact", {})).toBe(false);
    expect(studioDetached("designerReact", { components: ["designs"] })).toBe(true);
    // Scoped per section: tearing off Algorithms leaves the designer mounted here.
    expect(studioDetached("designerReact", { algorithms: ["algorithms"] })).toBe(false);
    expect(studioDetached("librarianRust", { algorithms: ["algorithms"] })).toBe(true);
    // And the Planner key, which used to carry all of them, now carries none.
    expect(studioDetached("designerReact", { projects: ["designs"] })).toBe(false);
  });
});

describe("studioPageShowing (#3357)", () => {
  // The studio pages are KEPT MOUNTED and merely CSS-hidden, so "mounted" is not "on screen" — if the
  // viewer count keyed off mounting it would never fall to 0 after a first visit and the reaper could
  // never fire. This is the rule that makes leaving the page actually count as leaving.
  it("is true only while its own WORKSPACE is active", () => {
    // Each graph is a rail destination now (`five-graphs-become-rail-workspaces`), so this compares
    // the workspace. It used to compare `projectsPageMode` because the graphs were Planner tabs;
    // leaving it that way made every dock report false forever — and since `openStudio` IS the lazy
    // launch, that is not a reaper leak but a total failure to start.
    expect(studioPageShowing("designerReact", { activeWorkspace: "components" }, null)).toBe(true);
    expect(studioPageShowing("designerReact", { activeWorkspace: "teams" }, null)).toBe(false);
    // Kept mounted but the user is on another workspace entirely → not showing.
    expect(studioPageShowing("designerReact", { activeWorkspace: "glance" }, null)).toBe(false);
    // And the Planner, which used to host it, is now just another workspace.
    expect(studioPageShowing("designerReact", { activeWorkspace: "projects" }, null)).toBe(false);
  });

  it("maps each studio to its own workspace", () => {
    const at = (w: string) => ({ activeWorkspace: w });
    expect(studioPageShowing("librarianRust", at("algorithms"), null)).toBe(true);
    expect(studioPageShowing("architect", at("teams"), null)).toBe(true);
    expect(studioPageShowing("soundDesigner", at("sounds"), null)).toBe(true);
    expect(studioPageShowing("librarianRust", at("teams"), null)).toBe(false);
  });

  it("starts the integrator from a page that actually exists", () => {
    // Its `sectionId` was "integrations", which was never a Planner tab — so its dock could never
    // report showing and the session could not start from a page at all. The Data graph is where
    // connectors and sources are read, so that is where it docks.
    expect(studioPageShowing("integrator", { activeWorkspace: "data" }, null)).toBe(true);
    expect(studioPageShowing("integrator", { activeWorkspace: "projects" }, null)).toBe(false);
  });

  it("reports EVERY studio as showing on some live workspace", () => {
    // The general form of the bug this slice fixes: a studio whose pageKey names nothing reachable
    // never starts, and nothing errors — it simply is not there. Checked against the registry so a
    // future rename cannot quietly strand one.
    const liveKeys = new Set(WORKSPACES.map((w) => w.key as string));
    for (const id of STUDIO_IDS) {
      const page = STUDIO_SESSIONS[id].pageKey;
      expect(liveKeys.has(page), `${id} docks on '${page}', which is not a live workspace`).toBe(true);
      expect(studioPageShowing(id, { activeWorkspace: page }, null)).toBe(true);
    }
  });

  // #a-stale-studio-id-in-a-record-must-not-kill-a-page — the regression, pinned.
  //
  // A component compiled from a RECORD can name a studio the app no longer defines: its source is
  // data the type system never checked. Before this guard `STUDIO_SESSIONS[retired]` was undefined
  // and `.sectionId` threw, escaping to GraphErrorBoundary and falling back the WHOLE Algorithms
  // page. One stale id in one dock, and the page was gone.
  it("returns false for an id the registry does not know, instead of throwing", () => {
    const at = { activeWorkspace: "algorithms" };
    for (const stale of ["librarian", "designer", "soundDesigner-typo", "planner"]) {
      // The cast is the POINT: this models a record naming a studio that no longer exists, which is
      // precisely what the type system cannot catch.
      const id = stale as unknown as Parameters<typeof studioPageShowing>[0];
      expect(() => studioPageShowing(id, at, null)).not.toThrow();
      expect(studioPageShowing(id, at, null)).toBe(false);
      // The torn-off branch reads `def.pageKey` too, so it needs the same guard.
      expect(() => studioPageShowing(id, at, { page: "algorithms", section: "algorithms" })).not.toThrow();
    }
  });

  // The NULL case was already handled and is a different one: null means "this dock resolved no
  // session for its technology", while a retired id is a non-null string that is simply not in the
  // registry. Keeping both pinned so a future simplification cannot collapse them.
  it("still returns false for a null/absent id", () => {
    const at = { activeWorkspace: "projects", projectsPageMode: "designs" };
    expect(studioPageShowing(null, at, null)).toBe(false);
    expect(studioPageShowing(undefined, at, null)).toBe(false);
  });

  it("a torn-off section window is showing exactly the page it was detached for", () => {
    // A detached window renders ONE page and has no rail, so its own `activeWorkspace` is irrelevant —
    // the detached identity decides. Pinned with a deliberately unrelated background workspace.
    const bg = { activeWorkspace: "glance" };
    expect(studioPageShowing("designerReact", bg, { page: "components", section: "designs" })).toBe(true);
    expect(studioPageShowing("librarianRust", bg, { page: "components", section: "designs" })).toBe(false);
  });
});
