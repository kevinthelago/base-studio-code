// Component → Algorithm cross-graph edge derivation (#3116) — the `requires` edges + referenced library
// nodes a kit's components declare via `@bsc/algorithms/…` imports. Reads the packaged seed (fibonacci.ts).
import { describe, it, expect } from "vitest";
import { resolveComponentAlgoRefs } from "./algoComposition";
import { crossGraphEdgeId } from "@/shared/lib/graph/crossGraph";
import type { ComponentRecord, Role } from "./model";

function comp(name: string, role: Role, extra: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: name, name, kitId: "react-ui", role, version: "1", used: 1, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "",
    source: "export const C = () => null;", ...extra,
  };
}

describe("resolveComponentAlgoRefs (#3116)", () => {
  it("derives a `requires` edge + the library node from a @bsc/algorithms/fibonacci import", () => {
    const fib = comp("FibCard", "composite", {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function FibCard(){ return fibonacci(10); }',
    });
    const { edges, nodes } = resolveComponentAlgoRefs([fib]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].urn).toBe("algo:typescript/fibonacci.ts");
    expect(nodes[0].label).toBe("fibonacci");
    expect(edges).toHaveLength(1);
    expect(edges[0].rel).toBe("requires");
    expect(edges[0].fromUrn).toBe("ui:react-ui/FibCard");
    expect(edges[0].toUrn).toBe("algo:typescript/fibonacci.ts");
    expect(edges[0].id).toBe(crossGraphEdgeId("ui:react-ui/FibCard", "algo:typescript/fibonacci.ts"));
  });

  it("ignores a component with NO library import, and an unresolvable @bsc reference", () => {
    const plain = comp("Plain", "primitive", { source: "export function Plain(){ return null; }" });
    const missing = comp("Bad", "composite", {
      source: 'import { nope } from "@bsc/algorithms/nope";\nexport function Bad(){ return nope(); }',
    });
    const { edges, nodes } = resolveComponentAlgoRefs([plain, missing]);
    expect(edges).toEqual([]);
    expect(nodes).toEqual([]);
  });

  it("dedupes the node across components and the edge within a component", () => {
    const a = comp("A", "composite", { source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function A(){ return fibonacci(1); }' });
    // Two references to the same algo from ONE component collapse to one edge; a second component adds an edge.
    const b = comp("B", "composite", {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nimport * as fib from "@bsc/algorithms/fibonacci.ts";\nexport function B(){ return fibonacci(2) + fib.fibonacci(3); }',
    });
    const { edges, nodes } = resolveComponentAlgoRefs([a, b]);
    expect(nodes).toHaveLength(1); // one canonical fibonacci node
    // A → fib, B → fib (B's two forms canonicalize to one edge) = 2 edges total.
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.fromUrn))).toEqual(new Set(["ui:react-ui/A", "ui:react-ui/B"]));
  });

  it("scans a usage-snippet srcText too (a visual affordance, not a build gate)", () => {
    const snippet = comp("Snip", "composite", {
      source: undefined,
      srcText: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\n<Snip value={fibonacci(5)} />',
    });
    const { edges } = resolveComponentAlgoRefs([snippet]);
    expect(edges).toHaveLength(1);
    expect(edges[0].toUrn).toBe("algo:typescript/fibonacci.ts");
  });
});
