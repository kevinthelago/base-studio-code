import { describe, it, expect } from "vitest";
import { buildPublishPlan, summarizePlan, type PublishInput } from "./publishAdapter";
import { personalProfile, orgProfile } from "../grading/capabilityMapping";
import { STRATEGY_PRESETS } from "../fleet/executionTopology";

function input(over: Partial<PublishInput> = {}): PublishInput {
  return {
    projectTitle: "Demo",
    phases: ["Phase 1", "Phase 2"],
    streams: ["api", "ui"],
    epics: [{ title: "Auth", childTitles: ["login", "logout"] }],
    dependencies: [{ from: "#2", to: "#1" }],
    profile: personalProfile(),
    strategy: STRATEGY_PRESETS["fleet-stream"], // milestoneAxis: phase
    ...over,
  };
}

describe("buildPublishPlan", () => {
  it("orders project -> phases -> labels -> epics -> dependencies", () => {
    const ops = buildPublishPlan(input());
    expect(ops.map((o) => o.op)).toEqual([
      "project",
      "milestone",
      "milestone",
      "label", // stream:api
      "label", // stream:ui
      "label", // epic (personal rung needs it)
      "epic",
      "dependency",
    ]);
    expect(ops[0]).toEqual({ op: "project", title: "Demo" });
    expect(ops.filter((o) => o.op === "label").map((o) => (o as { name: string }).name)).toEqual([
      "stream:api",
      "stream:ui",
      "epic",
    ]);
  });

  it("personal account uses the parent+sub-issues+label epic rung", () => {
    const ops = buildPublishPlan(input());
    const epic = ops.find((o) => o.op === "epic") as Extract<ReturnType<typeof buildPublishPlan>[number], { op: "epic" }>;
    expect(epic.representation).toBe("parent+sub-issues+label");
  });

  it("org account uses native issue types and needs no epic label", () => {
    const ops = buildPublishPlan(input({ profile: orgProfile() }));
    const epic = ops.find((o) => o.op === "epic") as Extract<ReturnType<typeof buildPublishPlan>[number], { op: "epic" }>;
    expect(epic.representation).toBe("issue-type+sub-issues");
    expect(ops.some((o) => o.op === "label" && (o as { name: string }).name === "epic")).toBe(false);
  });

  it("phases become iterations only with an iteration axis + Projects, else milestones", () => {
    const iterStrategy = { ...STRATEGY_PRESETS["fleet-stream"], milestoneAxis: "iteration" as const };
    expect(buildPublishPlan(input({ strategy: iterStrategy })).filter((o) => o.op === "iteration")).toHaveLength(2);
    // iteration axis but no Projects -> milestones
    expect(
      buildPublishPlan(input({ strategy: iterStrategy, profile: personalProfile({ projects: false }) })).filter(
        (o) => o.op === "milestone",
      ),
    ).toHaveLength(2);
  });

  it("dependency representation degrades with capability", () => {
    const dep = (i: PublishInput) =>
      (buildPublishPlan(i).find((o) => o.op === "dependency") as { representation: string }).representation;
    expect(dep(input())).toBe("project-field"); // personal: no native deps, has Projects
    expect(dep(input({ profile: orgProfile() }))).toBe("native-relationship");
  });
});

describe("summarizePlan", () => {
  it("counts ops by kind", () => {
    expect(summarizePlan(buildPublishPlan(input()))).toEqual({
      project: 1,
      milestone: 2,
      iteration: 0,
      label: 3,
      epic: 1,
      dependency: 1,
    });
  });
});
