import { describe, it, expect } from "vitest";
import {
  maturityRank,
  atLeast,
  isContractReady,
  flatten,
  findNode,
  kickableNodes,
  rollupMaturity,
  progress,
  type PlanNode,
  type NodeKind,
  type Maturity,
} from "./planNode";

function n(id: string, kind: NodeKind, maturity: Maturity, children: PlanNode[] = []): PlanNode {
  return { id, kind, title: id, maturity, children };
}

const tree = n("root", "layer", "stub", [
  n("api", "layer", "specified", [
    n("api-feat-1", "feature", "contract-ready"),
    n("api-feat-2", "feature", "sketched"),
  ]),
  n("data", "layer", "contract-ready", [n("data-comp", "component", "contract-ready")]),
]);

describe("maturity", () => {
  it("ranks in ascending order", () => {
    expect(maturityRank("stub")).toBe(0);
    expect(maturityRank("contract-ready")).toBe(3);
    expect(maturityRank("sketched")).toBeLessThan(maturityRank("specified"));
  });
  it("atLeast compares on the scale", () => {
    expect(atLeast("contract-ready", "specified")).toBe(true);
    expect(atLeast("sketched", "specified")).toBe(false);
    expect(atLeast("specified", "specified")).toBe(true);
  });
  it("isContractReady", () => {
    expect(isContractReady(n("x", "feature", "contract-ready"))).toBe(true);
    expect(isContractReady(n("x", "feature", "specified"))).toBe(false);
  });
});

describe("traversal", () => {
  it("flatten visits the whole subtree pre-order", () => {
    expect(flatten(tree).map((x) => x.id)).toEqual([
      "root",
      "api",
      "api-feat-1",
      "api-feat-2",
      "data",
      "data-comp",
    ]);
  });
  it("findNode locates nested nodes and returns null for misses", () => {
    expect(findNode(tree, "data-comp")?.id).toBe("data-comp");
    expect(findNode(tree, "nope")).toBeNull();
  });
});

describe("gating + rollup", () => {
  it("kickableNodes = work-kind nodes at contract-ready", () => {
    expect(kickableNodes(tree).map((x) => x.id).sort()).toEqual(["api-feat-1", "data-comp"]);
  });
  it("rollupMaturity is the min over the subtree", () => {
    expect(rollupMaturity(tree)).toBe("stub"); // root is stub
    const api = findNode(tree, "api")!;
    expect(rollupMaturity(api)).toBe("sketched"); // min(specified, contract-ready, sketched)
    const data = findNode(tree, "data")!;
    expect(rollupMaturity(data)).toBe("contract-ready");
  });
  it("progress counts contract-ready over total", () => {
    expect(progress(tree)).toEqual({ ready: 3, total: 6, percent: 50 });
  });
});
