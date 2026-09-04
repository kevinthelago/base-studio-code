// EVERY NODE KIND HAS A READING POSITION.
//
// The Glance sidebar groups by type, and the order is a decision — what the project is built ON, then
// what it IS, then who runs it. A kind with no rank would fall to an unspecified position that a
// reader would take for a judgement someone made.
//
// `Record<GNodeKind, number>` already makes an omission a compile error. This adds the two things the
// type cannot say: that the ORDER is the intended one, and that the sort actually applies it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NODE_KIND_ORDER, nodeKindRank } from "@/features/glance/lib/glanceGraph";

describe("NODE_KIND_ORDER", () => {
  it("ranks every kind the graph can produce", () => {
    // The union, read off the source rather than restated — a kind added to `GNodeKind` and forgotten
    // here is exactly what this guards, and a hand-copied list would forget it too.
    const seed = JSON.parse(readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8")) as {
      implementations: { id: string; code?: string }[];
    };
    const src = seed.implementations.find((i) => i.id === "glance-graph.ts")?.code ?? "";
    const decl = /export type GNodeKind =([^;]+);/.exec(src);
    expect(decl, "GNodeKind not found — this guard is reading the wrong shape").not.toBeNull();
    const kinds = [...decl![1].matchAll(/"(\w[\w-]*)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) {
      expect(NODE_KIND_ORDER[k as keyof typeof NODE_KIND_ORDER], `\`${k}\` has no reading position`).toBeTypeOf("number");
    }
  });

  it("reads dependencies → the program → its decomposition → the actors", () => {
    const r = NODE_KIND_ORDER;
    // A library is consumed and owned elsewhere; an MCP/service/integration is the same kind of thing,
    // so it sits beside one rather than among the project's own parts.
    expect(r.library).toBe(r.kit);
    expect(r.mcp).toBe(r.service);
    expect(r.mcp).toBe(r.integration);
    expect(r.library).toBeLessThan(r.mcp);
    // The program, then how it is decomposed, then who operates it.
    expect(r.mcp).toBeLessThan(r.feature);
    expect(r.feature).toBeLessThan(r.surface);
    expect(r.surface).toBeLessThan(r.session);
    expect(r.session).toBe(r.architect);
  });

  it("sorts a kind-less node LAST, not first", () => {
    // Rank 0 would put an unknown node at the top of the list, which reads as "most fundamental".
    expect(nodeKindRank({})).toBeGreaterThan(NODE_KIND_ORDER.session);
  });

  it("the sidebar actually applies it", () => {
    // A ranking nothing sorts by is a table of numbers. This repo has shipped that exact shape twice
    // (`featureBand` and `featureDrill`, each tested and uncalled), so the call site is asserted.
    const seed = JSON.parse(readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8")) as
      | { srcText?: string }
      | { srcText?: string }[];
    const rec = Array.isArray(seed) ? seed[0] : seed;
    expect(rec.srcText ?? "").toContain("nodeKindRank(a) - nodeKindRank(b)");
  });
});
