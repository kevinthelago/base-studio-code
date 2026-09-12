// Which skills a session receives comes from Rust, and the ways that read can FAIL stay
// distinguishable (`the-session-skill-fold-runs-twice-and-only-the-renderer-copy-serves-the-ui`).
//
// The thing worth pinning is not that the read works — it is that nothing here can turn a read that
// never ran into "this session has no skills". That is not a hypothetical: the generated fixture this
// slice inherits records a shipped bug where a session received NO skills and looked exactly like one
// that legitimately had none, because the only writer of `.claude/skills` was never reached.
//
// Mocks `invoke`, mirroring `rolePermsRead.test.ts` / `paneIdentityRead.test.ts`, so the real
// `safeInvoke` path is exercised rather than replaced.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readSessionSkills, answerFor, skillStateFor, effectiveSkillIds,
  type SessionSkillAnswer, type ResolvedSessionSkill,
} from "@/shared/lib/session/skillsSessionRead";

const state = (over: Partial<ResolvedSessionSkill> & { id: string }): ResolvedSessionSkill => ({
  name: over.id, on: true, reason: "global", overridden: false, ...over,
});

const answer = (label: string, over: Partial<SessionSkillAnswer> = {}): SessionSkillAnswer => ({
  label,
  projectId: "studio-code",
  states: [state({ id: "a" }), state({ id: "b", on: false, reason: "out-of-scope" })],
  effective: ["a"],
  ...over,
});

const skillCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "session_skills");

function reply(rows: unknown): void {
  vi.mocked(invoke).mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the session-skill read", () => {
  it("asks Rust ONCE for the whole batch, in-process, with every session in one call", async () => {
    reply([answer("p1"), answer("p2")]);
    const table = await readSessionSkills([
      { label: "p1", projectId: "studio-code" },
      { label: "p2", projectId: "other", groupIds: ["g1"] },
    ]);
    expect(table?.size).toBe(2);
    // The N+1 guard: one call for N sessions. A per-session call would reopen skills.db per pane —
    // the fan-out #3908/#3954 were filed to undo.
    expect(skillCalls()).toHaveLength(1);
    expect(skillCalls()[0][0]).toBe("session_skills");
  });

  it("IS AN IN-PROCESS COMMAND, not the `bsc` bridge — no process is spawned per read", async () => {
    reply([answer("p1")]);
    await readSessionSkills([{ label: "p1", projectId: "" }]);
    // `bsc` is the bridge that SPAWNS; this seam must never reach it.
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "bsc")).toHaveLength(0);
  });

  it("normalizes the request so an absent override/groups cross the wire as null/[]", async () => {
    reply([answer("p1")]);
    await readSessionSkills([{ label: "p1", projectId: "studio-code" }]);
    expect(skillCalls()[0][1]).toEqual({
      sessions: [{ label: "p1", projectId: "studio-code", override: null, groupIds: [] }],
    });
  });

  it("carries the session's GROUP ids, so the group reason cannot degrade to out-of-scope", async () => {
    // The seam must pass groups through: Rust expands them from the store, and a seam that dropped
    // them would silently resolve every group-carried skill as out of scope.
    reply([answer("p1")]);
    await readSessionSkills([{ label: "p1", projectId: "p", groupIds: ["grp-a", "grp-b"] }]);
    expect((skillCalls()[0][1] as { sessions: { groupIds: string[] }[] }).sessions[0].groupIds)
      .toEqual(["grp-a", "grp-b"]);
  });

  it("A FAILED READ IS NULL, NOT AN EMPTY TABLE — the caller must keep its own fold", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no backend") as never);
    expect(await readSessionSkills([{ label: "p1", projectId: "" }])).toBeNull();
  });

  it("treats an answer that is NOT A TABLE as a read that could not run", async () => {
    // `safeInvoke` resolves whatever the command produced; it cannot tell a table from an older
    // backend answering a different shape.
    for (const bad of [undefined, null, "nope", 42, { rows: [] }]) {
      reply(bad);
      expect(await readSessionSkills([{ label: "p1", projectId: "" }]), `for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("never hands a caller a half-shaped row — a malformed entry fails the whole read", async () => {
    reply([answer("p1"), { label: "p2", projectId: "x", states: "not-an-array", effective: [] }]);
    expect(await readSessionSkills([{ label: "p1", projectId: "" }])).toBeNull();
  });

  it("asking about NOTHING is an empty map, not a failure", async () => {
    // Nothing was asked and nothing failed, so this must not read as a dead backend.
    const table = await readSessionSkills([]);
    expect(table).not.toBeNull();
    expect(table?.size).toBe(0);
    expect(skillCalls()).toHaveLength(0);
  });
});

describe("ABSENT MUST NOT RENDER AS A VALUE", () => {
  it("a session that RESOLVES NOTHING is a real empty list; one that could not be read is null", async () => {
    // The distinction this module exists for, and the one the recorded bug turned on. `[]` means this
    // session receives no skills — a genuine answer. `null` means nobody could find out. Collapsing
    // them writes a session off as skill-less on the strength of a failed read.
    reply([answer("p1", { states: [], effective: [] })]);
    const table = await readSessionSkills([{ label: "p1", projectId: "" }]);
    expect(effectiveSkillIds(table, "p1")).toEqual([]);
    expect(effectiveSkillIds(table, "nosuchsession")).toBeNull();
    expect(effectiveSkillIds(null, "p1")).toBeNull();
  });

  it("a skill MISSING from the answer is null, not off", async () => {
    // A skill the answer does not carry is one the LIBRARY does not carry — a different fact from a
    // skill that resolved to off, and rendering it as off states a verdict nothing produced.
    reply([answer("p1")]);
    const table = await readSessionSkills([{ label: "p1", projectId: "" }]);
    expect(skillStateFor(table, "p1", "b")?.on).toBe(false);   // a real off
    expect(skillStateFor(table, "p1", "nosuchskill")).toBeNull(); // not an answer at all
  });

  it("a null table yields null for every accessor, with nothing for a `??` to fall through to", () => {
    expect(answerFor(null, "p1")).toBeNull();
    expect(skillStateFor(null, "p1", "a")).toBeNull();
    expect(effectiveSkillIds(null, "p1")).toBeNull();
  });

  it("a null or empty label never resolves to a row", async () => {
    reply([answer("p1")]);
    const table = await readSessionSkills([{ label: "p1", projectId: "" }]);
    expect(answerFor(table, null)).toBeNull();
    expect(answerFor(table, undefined)).toBeNull();
    expect(answerFor(table, "")).toBeNull();
  });
});

describe("the `overridden` rule survives the seam", () => {
  it("a REDUNDANT override is carried across as NOT a deviation", async () => {
    // `overridden` is `on !== baseline`, not "an override mentions it". The UI reads this to mark a
    // session as differing from its project baseline, so a redundant choice showing as a deviation is
    // a lie about what the user changed — and it is the step a port most easily loses.
    reply([answer("p1", { states: [state({ id: "a", on: true, reason: "global", overridden: false })] })]);
    const table = await readSessionSkills([{ label: "p1", projectId: "" }]);
    const st = skillStateFor(table, "p1", "a");
    expect(st?.on).toBe(true);
    expect(st?.overridden).toBe(false);
    expect(st?.reason).toBe("global");
  });

  it("a REAL deviation is carried across as one, with its added/removed reason", async () => {
    reply([answer("p1", {
      states: [
        state({ id: "a", on: true, reason: "added", overridden: true }),
        state({ id: "b", on: false, reason: "removed", overridden: true }),
      ],
    })]);
    const table = await readSessionSkills([{ label: "p1", projectId: "" }]);
    expect(skillStateFor(table, "p1", "a")).toMatchObject({ on: true, reason: "added", overridden: true });
    expect(skillStateFor(table, "p1", "b")).toMatchObject({ on: false, reason: "removed", overridden: true });
  });
});
