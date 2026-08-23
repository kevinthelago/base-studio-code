// THE TAB IS A LENS, NOT A PARTITION (`the-tab-is-a-lens-not-a-partition`).
//
// Selecting a language tab must change FOCUS — which nodes are laid out — and never which edges exist.
// The distinction is not decorative. Technology is a CURATION scope: `studioScopeDirective` splits the
// librarian per language so each curates its own partition, and that governs who may WRITE a record. It
// says nothing about what may REFERENCE one. The cross-graph URN grammar makes that concrete —
// `@bsc/algorithms/fibonacci` is kit-less, so a React component resolves a TypeScript implementation
// across both pillar AND technology (epic #3114, whose whole purpose was ending exactly that siloing).
//
// WHY THIS IS A GUARD AND NOT A FIX: measured against the seed today there are 578 within-language
// `composes` edges and ZERO that cross a language, so nothing is being dropped right now. `kitGraph`
// filters edges to targets inside the same language (`if (ids.has(c))`), which means the day someone
// adds a cross-language edge it will vanish from the view with no error and no warning — just a link
// that is not drawn. That is the failure this file exists to make loud, and it cannot be caught by
// eye: a missing edge looks exactly like an edge that was never authored.
import { describe, it, expect } from "vitest";
import { KNOWLEDGE, kitTechs, kitGraph, buildKnowledge, type AlgoImpl } from "@/features/algorithms/lib/knowledge";

/** Every `composes` edge in the graph whose target actually resolves, as `from->to`. */
const allResolvableEdges = (g: typeof KNOWLEDGE): Set<string> => {
  const ids = new Set(g.implementations.map((i) => i.id));
  const out = new Set<string>();
  for (const im of g.implementations) {
    for (const c of im.composes) if (ids.has(c)) out.add(`${im.id}->${c}`);
  }
  return out;
};

/** Every edge the UI actually renders, unioned across every tab a user can select. */
const renderedAcrossAllTabs = (g: typeof KNOWLEDGE): Set<string> => {
  const out = new Set<string>();
  for (const tech of kitTechs(g)) {
    for (const e of kitGraph(g, tech).edges) out.add(`${e.from}->${e.to}`);
  }
  return out;
};

describe("the language tab is a lens over the algorithms graph", () => {
  it("renders EVERY edge the store holds across the set of tabs — none is dropped", () => {
    // The property, stated directly: no tab selection may hide an edge from the graph entirely.
    const stored = allResolvableEdges(KNOWLEDGE);
    const rendered = renderedAcrossAllTabs(KNOWLEDGE);
    const missing = [...stored].filter((e) => !rendered.has(e));
    expect(
      missing,
      `${missing.length} edge(s) exist in the store but are drawn under NO tab — ` +
      `kitGraph drops any \`composes\` whose target is in another language. ` +
      `The tab must be a lens, not a partition: ${missing.slice(0, 5).join(", ")}`,
    ).toEqual([]);
    expect(stored.size).toBeGreaterThan(0); // the check is meaningless against an empty graph
  });

  it("FAILS LOUDLY for a graph that does have a cross-language edge — the guard actually guards", () => {
    // Proving the assertion above can fail. Without this, a tautology (an empty `missing` because
    // nothing is ever compared) would read exactly like a passing guard — which is the failure mode
    // this repo keeps getting caught by: a green check that sees less than the reader assumes.
    const im = (o: Partial<AlgoImpl> & Pick<AlgoImpl, "id" | "tech" | "name">): AlgoImpl =>
      ({ role: "algorithm", composes: [], ...o });
    const crossing = buildKnowledge({
      implementations: [
        im({ id: "caller.ts", tech: "typescript", name: "caller", composes: ["helper.rs"] }),
        im({ id: "helper.rs", tech: "rust", name: "helper" }),
      ],
    });
    expect(allResolvableEdges(crossing).has("caller.ts->helper.rs")).toBe(true);
    expect(
      renderedAcrossAllTabs(crossing).has("caller.ts->helper.rs"),
      "kitGraph drops a cross-language edge — this is the case the guard above is watching for",
    ).toBe(false);
  });

  it("gives each tab its own nodes, and every node exactly one tab", () => {
    // The other half of "focus, not partition": focus must be TOTAL and UNAMBIGUOUS. A node reachable
    // from no tab is unreachable in the UI; a node on two tabs is two copies of one record.
    const seen = new Map<string, number>();
    for (const tech of kitTechs(KNOWLEDGE)) {
      for (const n of kitGraph(KNOWLEDGE, tech).nodes) seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
    }
    const unreachable = KNOWLEDGE.implementations.filter((i) => !seen.has(i.id)).map((i) => i.id);
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    expect(unreachable, "impls reachable from no tab").toEqual([]);
    expect(duplicated, "impls appearing under more than one tab").toEqual([]);
  });
});
