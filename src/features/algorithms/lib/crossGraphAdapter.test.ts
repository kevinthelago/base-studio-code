// The algo-graph NodeLookup adapter (#3116) — the map from the algorithms store onto the shared
// cross-graph resolver. Verifies bare-name + exact-id resolution, the miss, and the code/kind carry-through.
import { describe, it, expect } from "vitest";
import { algoNodeLookup } from "./crossGraphAdapter";
import { buildKnowledge } from "./knowledge";

const graph = buildKnowledge({
  implementations: [
    { id: "fibonacci.ts", tech: "typescript", role: "algorithm", name: "fibonacci", composes: ["typescript.number"], code: "export function fibonacci(){}" },
    { id: "typescript.number", tech: "typescript", role: "primitive", name: "number", composes: [], ref: "number" },
    { id: "fibonacci.rs", tech: "rust", role: "algorithm", name: "fibonacci", composes: [], code: "pub fn fibonacci(){}" },
  ],
});

describe("algoNodeLookup (#3116)", () => {
  const lookup = algoNodeLookup(graph);

  it("resolves a TS algorithm by its BARE name and carries its code + kind", () => {
    const n = lookup("typescript", "fibonacci");
    expect(n).not.toBeNull();
    expect(n!.id).toBe("fibonacci.ts"); // the canonical impl id (so a caller can canonicalize the URN)
    expect(n!.label).toBe("fibonacci");
    expect(n!.kind).toBe("algorithm");
    expect(n!.code).toContain("export function fibonacci");
    expect(n!.graph).toBe("algo");
  });

  it("resolves the SAME impl by its exact id (fibonacci.ts)", () => {
    expect(lookup("typescript", "fibonacci.ts")?.id).toBe("fibonacci.ts");
  });

  it("scopes to the kit (a Rust fibonacci is a different node) and misses cleanly", () => {
    expect(lookup("rust", "fibonacci")?.id).toBe("fibonacci.rs");
    expect(lookup("typescript", "nope")).toBeNull();
    expect(lookup("python", "fibonacci")).toBeNull(); // an unseeded kit
  });

  it("resolves a primitive too — but with no code (a descriptor, not importable)", () => {
    const n = lookup("typescript", "number");
    expect(n?.kind).toBe("primitive");
    expect(n?.code).toBeUndefined();
  });
});
