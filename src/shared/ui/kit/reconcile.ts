// Blueprint design reconciliation (#2646, epic #2606) — the PURE diff behind the sharing layer. When a
// blueprint is downloaded, its design contribution (the categories it introduces + a theme ref) is
// reconciled against the LOCAL design contract: categories the contract doesn't define are gaps a
// dedicated confirm-list (5b) offers to fill via the generator (#2636), so a shared blueprint brings its
// look with NO holes. This module is the DIFF only — no download/confirm/generation wiring. Kept in
// shared/ (feature-agnostic, structural inputs) so the planner + a future reconciliation UI both use it.
import DESCRIPTOR from "@data/ui/style-descriptor.json";

interface DomainDescriptor {
  domain?: { group: string; tokens?: { key: string }[] }[];
}

/** The graph CATEGORY keys the local contract defines (the `graph-category` domain group): greenfield,
 *  transform, harden, maintain, data, script. A blueprint category outside this set is a gap the
 *  generator fills. Computed once from the descriptor. */
export const KNOWN_GRAPH_CATEGORIES: ReadonlySet<string> = (() => {
  const d = DESCRIPTOR as DomainDescriptor;
  const group = (d.domain ?? []).find((g) => g.group === "graph-category");
  return new Set((group?.tokens ?? []).map((t) => t.key));
})();

/** A blueprint's design contribution — the reconcilable shape (structural; the planner's `BlueprintDesign`
 *  is assignable to it, keeping shared/ free of a feature import). */
export interface DesignContribution {
  categories?: string[];
  theme?: string;
}

export interface DesignReconcile {
  /** Categories the blueprint introduces that the local contract does NOT define — the gaps to fill. */
  missingCategories: string[];
  /** The theme ref carried through (a `bsc ui theme` id), for the confirm-list to resolve/import (5b). */
  themeRef?: string;
  /** True when nothing needs reconciling (no missing categories). */
  complete: boolean;
}

/** Diff a blueprint's design contribution against the local contract (#2646). Pure. `known` defaults to
 *  the contract's graph-category keys; missing categories are deduped + sorted. */
export function reconcileDesign(
  design: DesignContribution | undefined,
  known: ReadonlySet<string> = KNOWN_GRAPH_CATEGORIES,
): DesignReconcile {
  const missingCategories = [...new Set((design?.categories ?? []).filter((c) => !known.has(c)))].sort();
  return { missingCategories, themeRef: design?.theme, complete: missingCategories.length === 0 };
}
