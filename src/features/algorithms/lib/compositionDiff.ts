// The intent-vs-reality composition diff (#2781, Phase 2 slice 4 · epic #2745/#2760). Graph 1's seed
// `composes` edges are the DECLARED composition (intent — what a concept is supposed to be built from);
// the extracted `calls` (#2779) are the OBSERVED composition (reality — what the real code actually
// invokes). This module diffs the two per concept and flags the drift, so the page can show where the
// curated ontology and the code have diverged. Pure + React/Tauri-free (like knowledge.ts / extraction.ts)
// so the tests, the canvas drift badge, and the inspector "Composition check" all share ONE model.
import type { KnowledgeGraph } from "./knowledge";
import type { ExtractResult } from "./extraction";

/**
 * The per-concept composition diff. Each field holds the OTHER concept ids (sorted + de-duped):
 * - `matched` — declared ∩ actual (the code confirms the declared composes edge),
 * - `missing` — declared − actual (declared, but not observed in code — often an abstract concept like
 *   divide-and-conquer or recursion that isn't literally called, so INFORMATIONAL, not an error),
 * - `extra`   — actual − declared (the code calls it, but the seed never declared the composition).
 */
export interface ConceptDiff {
  concept: string;
  matched: string[];
  missing: string[];
  extra: string[];
}

/** Sorted, de-duped copy of an id iterable. */
function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Diff each IMPLEMENTED concept's DECLARED composition (seed `composes` edges = intent) against its
 * OBSERVED composition (extracted `calls` = reality). Computed ONLY for concepts that carry a real
 * implementation — i.e. that appear as a `concept` on a matched extract site — so a concept the scan
 * never saw is ABSENT from the map (the inspector shows nothing for it). A concept WITH an
 * implementation whose declared === observed still gets an (all-empty) entry, so the inspector can
 * affirm "matches its declared composition" rather than silently omit it.
 *
 * @param graph the knowledge graph — its `rel: "composes"` edges are the declared composition
 * @param extract the `bsc graph extract` result — its `matched` sites gate which concepts are diffed,
 *   its `calls` are the observed composition
 * @returns concept id → its {@link ConceptDiff}, keyed only for implemented concepts
 */
export function composeDiff(graph: KnowledgeGraph, extract: ExtractResult): Map<string, ConceptDiff> {
  // The concepts with a real implementation — the only ones we can diff (a scan actually saw their code).
  const implemented = new Set<string>();
  for (const s of extract.matched) if (s.concept) implemented.add(s.concept);

  // declared[C] = the `to` of every composes edge from C (intent).
  const declared = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.rel !== "composes") continue;
    (declared.get(e.from) ?? declared.set(e.from, new Set()).get(e.from)!).add(e.to);
  }
  // actual[C] = the `to` of every extracted call from C (reality); multiple per-tech edges collapse.
  const actual = new Map<string, Set<string>>();
  for (const c of extract.calls) {
    (actual.get(c.from) ?? actual.set(c.from, new Set()).get(c.from)!).add(c.to);
  }

  const out = new Map<string, ConceptDiff>();
  for (const concept of implemented) {
    const dec = declared.get(concept) ?? new Set<string>();
    const act = actual.get(concept) ?? new Set<string>();
    const matched: string[] = [];
    const missing: string[] = [];
    for (const id of dec) (act.has(id) ? matched : missing).push(id);
    const extra: string[] = [];
    for (const id of act) if (!dec.has(id)) extra.push(id);
    out.set(concept, {
      concept,
      matched: sortedUnique(matched),
      missing: sortedUnique(missing),
      extra: sortedUnique(extra),
    });
  }
  return out;
}

/** The concepts whose observed composition DIVERGES from their declared one — any `missing` or
 *  `extra`. These are the nodes the canvas paints a drift indicator on (the "review" set); a concept
 *  with only `matched` (declared === observed) is deliberately NOT included. */
export function driftConcepts(diffs: Map<string, ConceptDiff>): Set<string> {
  const set = new Set<string>();
  for (const [id, d] of diffs) if (d.missing.length || d.extra.length) set.add(id);
  return set;
}
