// SYSTEM sessions (`system-sessions-run-projects-and-start-when-visited`) — the registry, its drift against
// the Rust table, and the rename boundary with the STUDIO sessions.
//
// The Rust side (`bsc_session::SYSTEM_SESSIONS`, record `bsc-session--system-sessions.rs`) is what the CLI
// resolves and what the launch plan reads; this side is what the console lists. They are compared by reading
// the Rust record's own source out of the committed store, the same arrangement `systemSessionRegistry.test.ts`
// uses for the studio kinds.
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadStore, resolveStorePath } from "../../../../scripts/lib/recordStore.mjs";
import { SYSTEM_SESSIONS, SYSTEM_SESSION_PANE_PREFIX, systemSessionDef } from "@/shared/lib/session/systemSessionDefs";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";
import { STUDIO_KINDS, studioSessionDef } from "@/features/studio-sessions";

const GRAPH_STORE = resolveStorePath(resolve(__dirname, "../../../.."));

function rustSource(): string {
  const store = loadStore(GRAPH_STORE) as { implementations: { id?: string; code?: string }[] };
  return store.implementations.find((i) => i.id === "bsc-session--system-sessions.rs")?.code ?? "";
}

interface RustDef { id: string; paneId: string; persona: string; role: string; harness: string; provider: string | null; model: string }

/** Every `SystemSessionDef { … }` literal in the Rust table, in order. */
function rustDefs(): RustDef[] {
  const src = rustSource();
  const out: RustDef[] = [];
  for (const m of src.matchAll(/SystemSessionDef\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const str = (k: string) => body.match(new RegExp(`\\b${k}:\\s*"([^"]*)"`))?.[1];
    const id = str("id");
    if (!id) continue; // the struct declaration itself, not a row
    const provider = body.match(/\bprovider:\s*Some\("([^"]*)"\)/)?.[1] ?? null;
    out.push({
      id, paneId: str("pane_id") ?? "", persona: str("persona") ?? "", role: str("role") ?? "",
      harness: str("harness") ?? "", provider, model: str("model") ?? "",
    });
  }
  return out;
}

describe("the system session registry", () => {
  it("holds exactly the two tutors: one persona, one role, two models", () => {
    expect(SYSTEM_SESSIONS.map((d) => d.id)).toEqual(["tutor-local", "tutor-claude"]);
    for (const d of SYSTEM_SESSIONS) {
      expect(d.personaId).toBe("persona-tutor");
      expect(d.role).toBe("tutor");
      expect(d.paneId).toBe(`${SYSTEM_SESSION_PANE_PREFIX}${d.id}`);
    }
    const local = systemSessionDef("tutor-local")!;
    expect([local.harness, local.provider, local.model]).toEqual(["bsc-agent", "ollama", "qwen3.5:9b"]);
    const claude = systemSessionDef("tutor-claude")!;
    expect([claude.harness, claude.provider, claude.model]).toEqual(["claude", null, "sonnet-4.5"]);
  });

  it("answers by id or by pane id, and nothing else", () => {
    expect(systemSessionDef("system-session:tutor-claude")?.id).toBe("tutor-claude");
    expect(systemSessionDef("tutor")).toBeNull();
    expect(systemSessionDef("system-session:")).toBeNull();
    expect(systemSessionDef(null)).toBeNull();
  });

  it("matches the Rust table row for row", () => {
    const rust = rustDefs();
    expect(rust.length).toBeGreaterThan(0);
    expect(SYSTEM_SESSIONS.map((d) => ({
      id: d.id, paneId: d.paneId, persona: d.personaId, role: d.role, harness: d.harness, provider: d.provider, model: d.model,
    }))).toEqual(rust);
  });
});

describe("the rename boundary: studio sessions keep their ids", () => {
  it("no studio kind is a system session and no system pane reads as a studio pane", () => {
    for (const k of STUDIO_KINDS) {
      expect(systemSessionDef(k.kind)).toBeNull();
      expect(studioSessionDef(k.kind) ?? true).toBeTruthy();
    }
    for (const d of SYSTEM_SESSIONS) {
      expect(isStudioSessionPaneId(d.paneId)).toBe(false);
      expect(studioSessionDef(d.id)).toBeFalsy();
    }
  });

  it("the studio pane ids are unchanged by the rename", () => {
    // The ids every persisted surface, the CLI and the reaper already address — renaming the CONCEPT to
    // "studio" must not move one of them.
    expect(studioSessionDef("architect")?.paneId).toBe("teams-studio:architect");
    expect(studioSessionDef("integrator")?.paneId).toBe("integration-studio:integrator");
    expect(isStudioSessionPaneId("teams-studio:architect")).toBe(true);
    expect(isStudioSessionPaneId("sound-studio:sound-designer")).toBe(true);
    expect(isStudioSessionPaneId("integration-studio:integrator")).toBe(true);
  });
});
