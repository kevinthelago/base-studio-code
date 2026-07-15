// Component → library cross-graph edge derivation (#3116 algorithms, #3117 sounds) — the `requires` edges +
// referenced library nodes a kit's components declare via `@bsc/algorithms/…` / `@bsc/sounds/…` imports.
// Reads the packaged seeds (the flagship `fibonacci.ts` algorithm + the default `signal` sound kit).
import { describe, it, expect } from "vitest";
import { resolveComponentLibraryRefs } from "./libraryComposition";
import { crossGraphEdgeId } from "@/shared/lib/graph/crossGraph";
import type { ComponentRecord, Role } from "./model";

function comp(name: string, role: Role, extra: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: name, name, kitId: "react-ui", role, version: "1", used: 1, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "",
    source: "export const C = () => null;", ...extra,
  };
}

describe("resolveComponentLibraryRefs — algorithms (#3116)", () => {
  it("derives a `requires` edge + the library node from a @bsc/algorithms/fibonacci import", () => {
    const fib = comp("FibCard", "composite", {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function FibCard(){ return fibonacci(10); }',
    });
    const { edges, nodes } = resolveComponentLibraryRefs([fib]);
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
    const { edges, nodes } = resolveComponentLibraryRefs([plain, missing]);
    expect(edges).toEqual([]);
    expect(nodes).toEqual([]);
  });

  it("dedupes the node across components and the edge within a component", () => {
    const a = comp("A", "composite", { source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function A(){ return fibonacci(1); }' });
    const b = comp("B", "composite", {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nimport * as fib from "@bsc/algorithms/fibonacci.ts";\nexport function B(){ return fibonacci(2) + fib.fibonacci(3); }',
    });
    const { edges, nodes } = resolveComponentLibraryRefs([a, b]);
    expect(nodes).toHaveLength(1); // one canonical fibonacci node
    expect(edges).toHaveLength(2); // A → fib, B → fib (B's two forms canonicalize to one edge)
    expect(new Set(edges.map((e) => e.fromUrn))).toEqual(new Set(["ui:react-ui/A", "ui:react-ui/B"]));
  });

  it("scans a usage-snippet srcText too (a visual affordance, not a build gate)", () => {
    const snippet = comp("Snip", "composite", {
      source: undefined,
      srcText: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\n<Snip value={fibonacci(5)} />',
    });
    const { edges } = resolveComponentLibraryRefs([snippet]);
    expect(edges).toHaveLength(1);
    expect(edges[0].toUrn).toBe("algo:typescript/fibonacci.ts");
  });
});

describe("resolveComponentLibraryRefs — sounds (#3117)", () => {
  it("derives a `requires` edge + the sound cue node from a @bsc/sounds/click import", () => {
    const play = comp("PlayBtn", "composite", {
      source: 'import { play } from "@bsc/sounds/click";\nexport function PlayBtn(){ return <button onClick={() => play()} />; }',
    });
    const { edges, nodes } = resolveComponentLibraryRefs([play]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].urn).toBe("sound:signal/click");
    expect(nodes[0].label).toBe("Click");
    expect(nodes[0].kind).toBe("cue");
    expect(nodes[0].code).toContain("export function play"); // the vendored player travels on the node
    expect(edges).toHaveLength(1);
    expect(edges[0].rel).toBe("requires");
    expect(edges[0].fromUrn).toBe("ui:react-ui/PlayBtn");
    expect(edges[0].toUrn).toBe("sound:signal/click");
  });

  it("collects ALGORITHM + SOUND refs together, one band node each, and drops a missing sound ref", () => {
    const both = comp("Mixed", "composite", {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nimport { play } from "@bsc/sounds/click";\nimport { play as boom } from "@bsc/sounds/nope";\nexport function Mixed(){ return fibonacci(play() + boom()); }',
    });
    const { edges, nodes } = resolveComponentLibraryRefs([both]);
    // the algorithm + the real cue resolve (2 nodes / 2 edges); the missing sound ref is dropped.
    expect(new Set(nodes.map((n) => n.urn))).toEqual(new Set(["algo:typescript/fibonacci.ts", "sound:signal/click"]));
    expect(edges).toHaveLength(2);
  });
});
