// App-owned studio sessions (#3137) — the recovery-exclusion source of truth.
import { describe, it, expect } from "vitest";
import {
  isStudioSessionPaneId,
  isFullCapabilitySession,
  STUDIO_SESSION_PANE_IDS,
  designerSessionId,
  librarianSessionId,
  TEAMS_STUDIO_SESSION_ID,
  DEBUG_STUDIO_SESSION_ID,
} from "./systemSessions";

describe("isStudioSessionPaneId (#3137)", () => {
  it("matches each app-owned studio session id", () => {
    for (const id of [designerSessionId("react"), librarianSessionId("rust"), TEAMS_STUDIO_SESSION_ID, DEBUG_STUDIO_SESSION_ID]) {
      expect(isStudioSessionPaneId(id)).toBe(true);
    }
    // #system-sessions-are-per-technology: the pane ids are per-tech, and the TAIL carries the
    // technology after a HYPHEN — a second colon would change what anything splitting the tail sees.
    expect(STUDIO_SESSION_PANE_IDS).toContain("design-studio:designer-react");
    expect(STUDIO_SESSION_PANE_IDS).toContain("algorithms-studio:librarian-rust");
    for (const id of STUDIO_SESSION_PANE_IDS) expect(id.split(":")).toHaveLength(2);
    expect(STUDIO_SESSION_PANE_IDS).toContain("teams-studio:architect");
    expect(STUDIO_SESSION_PANE_IDS).toContain("debug-studio:debugger");
  });

  it("does NOT match real fleet / manual / planner ids (they share the `<key>:<tail>` shape)", () => {
    for (const id of ["proj:auth", "proj:director", "own/web:triage", "man:scratch:p0", "planning_proj", "garbage"]) {
      expect(isStudioSessionPaneId(id)).toBe(false);
    }
  });

  it("is exactly the app-owned studios — a new one must be added here to be excluded", () => {
    expect([...STUDIO_SESSION_PANE_IDS].sort()).toEqual(
      // #system-sessions-are-per-technology: one pane id per per-tech session for the two studios whose
      // store is partitioned. Every id keeps the `<key>:<tail>` grammar — the technology rides in the
      // TAIL after a hyphen, never as a second colon.
      ["algorithms-studio:librarian-python", "algorithms-studio:librarian-rust",
       "algorithms-studio:librarian-typescript", "debug-studio:debugger",
       "design-studio:designer-react", "design-studio:designer-react-native",
       "integration-studio:integrator", "sound-studio:sound-designer", "teams-studio:architect"],
    );
  });
});

describe("isFullCapabilitySession (#3326)", () => {
  it("is true for the standing debug session — the always-bypass carve-out", () => {
    expect(isFullCapabilitySession(DEBUG_STUDIO_SESSION_ID)).toBe(true);
  });

  it("is true for EVERY auto-spawned per-request debug session (#3520)", () => {
    // A `debug-studio:req-<id>` session is the same full-capability actor as the standing one — app-owned,
    // in the source tree, working the request queue. It must launch bypass too, or it stops to ask for
    // every edit; the control gate is the human reviewing its PR, not a per-tool prompt.
    for (const id of ["debug-studio:req-1", "debug-studio:req-7", "debug-studio:req-142"]) {
      expect(isFullCapabilitySession(id)).toBe(true);
    }
  });

  it("is false for the other studios (they keep their bespoke launch postures)", () => {
    for (const id of [designerSessionId("react"), librarianSessionId("rust"), TEAMS_STUDIO_SESSION_ID]) {
      expect(isFullCapabilitySession(id)).toBe(false);
    }
  });

  it("is false for fleet / manual / planner ids (they follow the global posture)", () => {
    // Including a `debug-studio`-ish decoy that is NOT the prefix — the match is on `debug-studio:`, so a
    // pane merely CONTAINING the word must not slip through.
    for (const id of ["proj:auth", "proj:director", "own/web:triage", "man:scratch:p0", "planning_proj", "my-debug-studio:x"]) {
      expect(isFullCapabilitySession(id)).toBe(false);
    }
  });
});
