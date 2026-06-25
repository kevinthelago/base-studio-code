import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseJudgeVerdict, selectForJudging } from "./wardenJudge";

describe("buildJudgePrompt", () => {
  it("includes the assignment + observed activity, and asks for JSON only", () => {
    const { system, user } = buildJudgePrompt({
      streamId: "api",
      ownedGlobs: ["src/api/**"],
      issues: ["#42"],
      changedFiles: ["src/api/routes.ts"],
      commands: ["git commit -m x"],
    });
    expect(system).toContain("read-only security warden");
    expect(system).toContain('"drifted"');
    expect(user).toContain("stream: api");
    expect(user).toContain("src/api/**");
    expect(user).toContain("#42");
    expect(user).toContain("src/api/routes.ts");
    expect(user).toContain("git commit -m x");
  });

  it("renders empty sections as (none)", () => {
    const { user } = buildJudgePrompt({ streamId: "x", ownedGlobs: [], issues: [], changedFiles: [], commands: [] });
    expect(user).toContain("(none)");
  });
});

describe("parseJudgeVerdict", () => {
  it("reads a drifted verdict with its reason", () => {
    const v = parseJudgeVerdict('Sure. {"drifted": true, "reason": "edited the auth subsystem, unrelated"}');
    expect(v.drifted).toBe(true);
    expect(v.reason).toBe("edited the auth subsystem, unrelated");
  });

  it("reads an on-task verdict", () => {
    expect(parseJudgeVerdict('{"drifted": false, "reason": "all within src/api"}').drifted).toBe(false);
  });

  it("fails OPEN on garbage / missing fields (never quarantines on a parse wobble)", () => {
    expect(parseJudgeVerdict("the model rambled with no json").drifted).toBe(false);
    expect(parseJudgeVerdict("{not valid json").drifted).toBe(false);
    expect(parseJudgeVerdict('{"something": "else"}').drifted).toBe(false);
  });

  it("a drifted verdict missing a reason still gets a default", () => {
    expect(parseJudgeVerdict('{"drifted": true}')).toEqual({ drifted: true, reason: "off-task activity" });
  });
});

describe("selectForJudging", () => {
  it("round-robins one pane per call, by cycle", () => {
    const panes = ["t0p1", "t0p2", "t0p3"];
    expect(selectForJudging(panes, 0, new Set())).toBe("t0p1");
    expect(selectForJudging(panes, 1, new Set())).toBe("t0p2");
    expect(selectForJudging(panes, 3, new Set())).toBe("t0p1");
  });

  it("excludes quarantined panes and returns null when none are eligible", () => {
    expect(selectForJudging(["t0p1", "t0p2"], 0, new Set(["t0p1"]))).toBe("t0p2");
    expect(selectForJudging(["t0p1"], 0, new Set(["t0p1"]))).toBeNull();
    expect(selectForJudging([], 0, new Set())).toBeNull();
  });
});
