import { describe, it, expect } from "vitest";
import {
  findGaps,
  partitionGaps,
  topGaps,
  rankRelevant,
  searchNodes,
  type Gap,
} from "../screens/planner/shared/discoverability";
import type { PlanNode, NodeKind, Maturity } from "../screens/planner/planNode";
import type { Shape } from "../screens/planner/data/shape";

function n(id: string, kind: NodeKind, maturity: Maturity, children: PlanNode[] = [], summary?: string): PlanNode {
  return { id, kind, title: id.replace(/^layer:/, ""), maturity, summary, children };
}

const plan = n("root", "root", "specified", [
  n("layer:api", "layer", "contract-ready", [], "REST endpoints"),
  n("layer:domain", "layer", "stub"),
]);

const policyShape: Shape = {
  id: "s",
  name: "s",
  source: "org",
  layers: [{ id: "auth", title: "Auth", tier: "policy" }],
};

describe("findGaps", () => {
  it("pushes a missing policy layer", () => {
    const gaps = findGaps({ plan, shape: policyShape });
    expect(gaps).toContainEqual(
      expect.objectContaining({ kind: "policy-layer", severity: "push", nodeId: "layer:auth" }),
    );
  });

  it("pushes a declared-but-unaddressed dimension", () => {
    const gaps = findGaps({ plan, answeredDimensions: ["auth"] });
    expect(gaps).toContainEqual(
      expect.objectContaining({ kind: "unaddressed-dimension", severity: "push" }),
    );
    // datastore -> data layer is absent too
    expect(findGaps({ plan, answeredDimensions: ["api"] }).some((g) => g.kind === "unaddressed-dimension")).toBe(false);
  });

  it("pulls a still-stub layer as a soft suggestion", () => {
    const gaps = findGaps({ plan });
    expect(gaps).toContainEqual(
      expect.objectContaining({ kind: "underspecified", severity: "pull", nodeId: "layer:domain" }),
    );
  });

  it("folds in external gaps", () => {
    const ext: Gap = { kind: "external", severity: "push", title: "dangling consume X", provenance: "contracts" };
    expect(findGaps({ plan, externalGaps: [ext] })).toContainEqual(ext);
  });
});

describe("partitionGaps / topGaps", () => {
  const gaps = findGaps({ plan, shape: policyShape, answeredDimensions: ["auth"] });

  it("splits push vs pull", () => {
    const { push, pull } = partitionGaps(gaps);
    expect(push.every((g) => g.severity === "push")).toBe(true);
    expect(pull.every((g) => g.severity === "pull")).toBe(true);
    expect(pull.some((g) => g.kind === "underspecified")).toBe(true);
  });

  it("ranks pushed gaps (policy first) and caps", () => {
    const top = topGaps(gaps, 1);
    expect(top).toHaveLength(1);
    expect(top[0].kind).toBe("policy-layer");
  });
});

describe("rankRelevant", () => {
  const apiNode = n("layer:api", "layer", "stub"); // terms: {layer, api}
  it("ranks by tag/term overlap, drops zero, caps, stable tie-break", () => {
    const ranked = rankRelevant(apiNode, [
      { id: "kb1", tags: ["api", "rest"] }, // 1
      { id: "kb2", tags: ["layer", "api"] }, // 2
      { id: "kb3", tags: ["mobile"] }, // 0 -> dropped
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["kb2", "kb1"]);
    expect(ranked[0].score).toBe(2);
  });
  it("respects the cap", () => {
    expect(rankRelevant(apiNode, [{ id: "a", tags: ["api"] }, { id: "b", tags: ["layer"] }], 1)).toHaveLength(1);
  });
});

describe("searchNodes", () => {
  it("matches title or summary, case-insensitively", () => {
    expect(searchNodes(plan, "REST").map((x) => x.id)).toEqual(["layer:api"]); // summary
    expect(searchNodes(plan, "DOMAIN").map((x) => x.id)).toEqual(["layer:domain"]); // title
    expect(searchNodes(plan, "")).toEqual([]);
  });
});
