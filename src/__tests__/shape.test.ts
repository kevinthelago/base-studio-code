import { describe, it, expect } from "vitest";
import {
  composeShapes,
  resolveCascade,
  shapeToNodes,
  validateShapePolicy,
  BUILTIN_ARCHETYPES,
  type Shape,
} from "../screens/planner/shape";

function shape(id: string, layers: Shape["layers"], over: Partial<Shape> = {}): Shape {
  return { id, name: id, source: "builtin", layers, ...over };
}

describe("composeShapes", () => {
  it("unions layers across the cascade", () => {
    const a = shape("a", [{ id: "domain", title: "Domain", tier: "default" }]);
    const b = shape("b", [{ id: "data", title: "Data", tier: "default" }]);
    expect(composeShapes([a, b]).layers.map((l) => l.id).sort()).toEqual(["data", "domain"]);
  });

  it("policy is sticky regardless of cascade order (lower can't downgrade)", () => {
    const adv = shape("adv", [{ id: "auth", title: "Auth", tier: "default" }]);
    const pol = shape("pol", [{ id: "auth", title: "Auth", tier: "policy" }]);
    const tierOf = (s: Shape) => s.layers.find((l) => l.id === "auth")!.tier;
    expect(tierOf(composeShapes([adv, pol]))).toBe("policy");
    expect(tierOf(composeShapes([pol, adv]))).toBe("policy");
  });

  it("merges contracts within a shared layer and unions dimensions", () => {
    const a = shape("a", [{ id: "api", title: "API", tier: "default", contracts: [{ name: "X", tier: "default" }] }], { dimensions: ["api"] });
    const b = shape("b", [{ id: "api", title: "API", tier: "default", contracts: [{ name: "X", tier: "policy" }, { name: "Y", tier: "default" }] }], { dimensions: ["auth"] });
    const out = composeShapes([a, b]);
    const api = out.layers.find((l) => l.id === "api")!;
    expect(api.contracts).toEqual([
      { name: "X", tier: "policy" }, // policy-sticky merge
      { name: "Y", tier: "default" },
    ]);
    expect(out.dimensions?.sort()).toEqual(["api", "auth"]);
  });

  it("returns an empty shape for an empty cascade", () => {
    expect(composeShapes([]).layers).toEqual([]);
  });
});

describe("resolveCascade", () => {
  it("expands extends into [base, …, shape]", () => {
    const base = shape("base", [{ id: "domain", title: "Domain", tier: "default" }]);
    const child = shape("child", [{ id: "api", title: "API", tier: "default" }], { extends: "base" });
    expect(resolveCascade(child, { base, child }).map((s) => s.id)).toEqual(["base", "child"]);
  });

  it("stops on an unknown base or a cycle", () => {
    const child = shape("child", [], { extends: "missing" });
    expect(resolveCascade(child, { child }).map((s) => s.id)).toEqual(["child"]);
    const a = shape("a", [], { extends: "b" });
    const b = shape("b", [], { extends: "a" });
    expect(resolveCascade(a, { a, b }).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("shapeToNodes", () => {
  it("makes one stub layer node per layer", () => {
    const s = shape("s", [{ id: "api", title: "API", tier: "default" }]);
    expect(shapeToNodes(s)).toEqual([
      { id: "layer:api", kind: "layer", title: "API", maturity: "stub", children: [] },
    ]);
  });
});

describe("validateShapePolicy", () => {
  const s = shape("s", [
    { id: "auth", title: "Auth", tier: "policy", contracts: [{ name: "AuthContract", tier: "policy" }] },
    { id: "ui", title: "UI", tier: "default" },
  ]);

  it("flags a missing policy layer", () => {
    expect(validateShapePolicy(s, [])).toEqual([{ kind: "layer", layer: "auth" }]);
  });

  it("flags a present policy layer that's missing a policy contract", () => {
    expect(validateShapePolicy(s, ["auth"], { auth: [] })).toEqual([
      { kind: "contract", layer: "auth", contract: "AuthContract" },
    ]);
  });

  it("passes when policy layers + contracts are satisfied; advisory never required", () => {
    expect(validateShapePolicy(s, ["auth"], { auth: ["AuthContract"] })).toEqual([]);
  });
});

describe("BUILTIN_ARCHETYPES", () => {
  it("api-service has the expected advisory layers", () => {
    const ids = BUILTIN_ARCHETYPES["api-service"].layers.map((l) => l.id);
    expect(ids).toEqual(["api", "domain", "data", "auth", "infra"]);
    expect(BUILTIN_ARCHETYPES["api-service"].layers.every((l) => l.tier === "default")).toBe(true);
  });
});
