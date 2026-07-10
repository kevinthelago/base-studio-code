// The extracted-from-code implementation model (#2777, Phase 2 slice 2 · epic #2745/#2760). Where
// knowledge.ts is "Graph 1" (the curated concept ontology), THIS is the reality lift: `bsc graph
// extract <dir>` parses real source and reports, per concept, the actual implementation SITES it found —
// so the page can show how many real implementations exist and flag DUPLICATES (a concept implemented at
// >1 site). Pure + React/Tauri-free (the bridge lives in extractionBridge.ts) so the tests, the node
// dedup badge, and the inspector's site list all share ONE model.

/** One implementation site `bsc graph extract` found. `concept` is absent on an `unmatched` site
 *  (parsed real code the extractor couldn't map onto a seed concept). */
export interface ExtractSite {
  /** The concept id this site implements — absent on an `unmatched` site. */
  concept?: string;
  /** The language of the site (e.g. "typescript", "rust"). */
  tech: string;
  /** The symbol/function name at the site, when the extractor names it. */
  name?: string;
  /** The file the site lives in (repo-relative; may be long → the inspector ellipsizes it). */
  file: string;
  /** 1-based line of the site. */
  line: number;
}

/** A concept implemented at MORE THAN ONE site — the dedup signal. `count === sites.length`. */
export interface DuplicateGroup {
  concept: string;
  count: number;
  sites: ExtractSite[];
}

/** One concept→concept CALL edge `bsc graph extract` lifted from real code (#2779): the function
 *  mapping onto `from` calls the function mapping onto `to`, in language `tech`. This is the reverse
 *  of the `implements` join — real-code COMPOSITION (who invokes whom), overlaid on the curated spine. */
export interface CallEdge {
  from: string;
  to: string;
  tech: string;
}

/** The full `bsc graph extract` result: sites matched to a concept, sites that matched none, the
 *  duplicate groups (concepts carrying >1 matched site), and the extracted concept→concept call edges. */
export interface ExtractResult {
  matched: ExtractSite[];
  unmatched: ExtractSite[];
  duplicates: DuplicateGroup[];
  /** Concept→concept call edges lifted from real code (#2779). Empty when none were found (or when
   *  the bundled `bsc` predates the verb — the bridge defaults it to `[]` so old output still parses). */
  calls: CallEdge[];
}

/** Matched sites grouped by their `concept` id (insertion order preserved). Unmatched sites — and any
 *  matched site missing a `concept` — never appear. */
export function sitesByConcept(r: ExtractResult): Map<string, ExtractSite[]> {
  const map = new Map<string, ExtractSite[]>();
  for (const s of r.matched) {
    if (!s.concept) continue;
    const list = map.get(s.concept) ?? map.set(s.concept, []).get(s.concept)!;
    list.push(s);
  }
  return map;
}

/** concept id → number of matched sites — the count the node dedup badge shows. */
export function siteCounts(r: ExtractResult): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of r.matched) {
    if (!s.concept) continue;
    counts.set(s.concept, (counts.get(s.concept) ?? 0) + 1);
  }
  return counts;
}

/** The concept ids that have MORE THAN ONE implementation (from `r.duplicates`) — the WARNING-tone set
 *  the badge paints and the headline dedup signal. */
export function duplicateConcepts(r: ExtractResult): Set<string> {
  return new Set(r.duplicates.map((d) => d.concept));
}

/** The OUTBOUND extracted call edges of a concept (#2779) — the concepts its real-code implementation
 *  invokes/composes. Empty when the concept makes no extracted concept→concept call. */
export function callsFor(r: ExtractResult, conceptId: string): CallEdge[] {
  return r.calls.filter((c) => c.from === conceptId);
}
