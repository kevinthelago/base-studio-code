// #1362 — the frontend lessons bridge + the lesson → project-skill mapping.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  loadPendingLessons, confirmLesson, discardLesson, lessonTitle, lessonToSkill, type Lesson,
} from "./lessons";
import { skillSlug } from "./skills";

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: "lesson-abc", mistake: "Ran targeted vitest", cause: "", rule: "Run the full suite",
  provenance: "pane t0p1", status: "pending", seen: 1, createdAt: 0, updatedAt: 0, ...over,
});

describe("lessons bridge (#1362)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("loadPendingLessons drives `bsc plan lesson list --status pending` and parses the JSON", async () => {
    // The bridge (#2114) returns raw stdout — a JSON string — which bscJson parses back to Lesson[].
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return JSON.stringify([lesson()]);
    });
    const out = await loadPendingLessons("proj-key");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("lesson-abc");
    expect(calls[0]).toEqual({
      cmd: "bsc",
      args: { projectKey: "proj-key", args: ["plan", "lesson", "list", "--status", "pending"] },
    });
  });

  it("loadPendingLessons returns [] for an empty key, empty output, and on bridge failure", async () => {
    expect(await loadPendingLessons("")).toEqual([]);
    vi.mocked(invoke).mockResolvedValue(""); // no plan.db yet ⇒ empty stdout ⇒ fallback
    expect(await loadPendingLessons("proj-key")).toEqual([]);
    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    expect(await loadPendingLessons("proj-key")).toEqual([]);
  });

  it("confirm / discard drive the matching `bsc plan lesson` verbs", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => { calls.push({ cmd, args }); return ""; });
    await confirmLesson("k", "id1");
    await discardLesson("k", "id2");
    expect(calls).toEqual([
      { cmd: "bsc", args: { projectKey: "k", args: ["plan", "lesson", "confirm", "id1"] } },
      { cmd: "bsc", args: { projectKey: "k", args: ["plan", "lesson", "discard", "id2"] } },
    ]);
  });
});

describe("lessonTitle / lessonToSkill (#1362)", () => {
  it("titles by the rule, falling back to the mistake, capped", () => {
    expect(lessonTitle({ mistake: "m", rule: "Run the full suite" })).toBe("Run the full suite");
    expect(lessonTitle({ mistake: "fallback to me", rule: "" })).toBe("fallback to me");
    const long = "x".repeat(100);
    expect(lessonTitle({ mistake: "", rule: long }).length).toBe(62); // 61 chars + the ellipsis
  });

  it("maps a confirmed lesson to a project-scoped review skill with a mistake→rule body", () => {
    const skill = lessonToSkill(lesson({ cause: "was in a hurry" }), "proj-key")!;
    expect(skill).toMatchObject({
      id: "lesson-skill-lesson-abc",
      kind: "review",
      enabled: true,
      projects: ["proj-key"],
    });
    expect(skill.name).toBe("Run the full suite");
    expect(skill.prompt).toContain("When: Ran targeted vitest");
    expect(skill.prompt).toContain("Why: was in a hurry");
    expect(skill.prompt).toContain("Do: Run the full suite");
    // It slugs to a real directory name (so write_session_skills will materialize it).
    expect(skillSlug(skill.name)).toBeTruthy();
  });

  it("returns null when there's nothing nameable", () => {
    expect(lessonToSkill(lesson({ mistake: "", rule: "" }), "k")).toBeNull();
  });
});
