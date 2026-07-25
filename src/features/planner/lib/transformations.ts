// Transformations stage (#2509 slice a) — the pure data model behind the planner's transformations
// substrate: the modification counterpart to features. The planner decomposes a modification
// request into verb-shaped rows (`bsc plan transformation add`), the poll reflects the plan.db list
// into `planTransformations`, and the pane presents them as a BOTTOM-UP CONFIRM QUEUE (the settled
// presentation model): grouped by composition tier (0 = primitives … N = pages), only the lowest
// tier with pending work is actionable, and confirmation unlocks the next tier — so composites are
// generated against confirmed primitives and nothing is built on unreviewed foundations. An item is
// pending or confirmed, NOTHING ELSE (no rejections/exclusions — changes are described to the
// planner conversationally and the item re-presents). Pure (no React/Tauri) so it's unit-testable.
//
// The verb/recipe/tier TAXONOMY is `@data` (#2509 slice b, `@data/transformations/taxonomy.json`,
// per the config-externalization standard #2027): the SAME file `crates/plandb` embeds for the
// `bsc plan transformation` set-time enums, so the vocabulary can't drift between the CLI
// validator and the pane's display metadata (verbMeta tooltips, tierLabel headings).

import { visitNodes, type GeneralNode } from "@/shared/ui/spec";
import taxonomyEmbedded from "@data/transformations/taxonomy.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** The identified piece of the existing system a transformation modifies — discovered by
 *  scanning, never invented. */
export interface TransformationTarget {
  description: string;
  files?: string[];
}

/** Where a row came from: the generating recipe (e.g. migrate-to-kit) + the scanned evidence
 *  (the bespoke implementations it replaces/generalizes). */
export interface TransformationProvenance {
  recipe?: string;
  evidence?: string[];
}

/** One `bsc plan transformation list --json` row — the unit of modification (#2509):
 *  verb · target · delta · invariants · blast radius, plus the confirm-queue fields
 *  (`tier`/`confirmed`) and the optional live-render `spec` (a node tree). */
export interface TransformationRow {
  id: string;
  /** From the verb taxonomy (rename · extract · split · merge · …) — each has a known recipe. */
  verb: string;
  title: string;
  target: TransformationTarget;
  /** from-state → to-state. */
  delta: string;
  /** What must NOT change — the modification twin of acceptance criteria. */
  invariants: string[];
  /** Blast radius: owned globs (maps 1:1 onto stream partitioning). */
  owns: string[];
  /** Planning-time sequencing hint (never a runtime wait, #1039). */
  dependsOn?: string[];
  /** Composition tier: 0 = primitives … N = pages. Drives the bottom-up confirm order. */
  tier: number;
  provenance?: TransformationProvenance;
  /** A gap-fill that contributes a missing abstraction to the kit itself. */
  kitContribution?: boolean;
  /** A render spec (#1852, general node form since #3500) — rendered live through KitRenderer. */
  spec?: object;
  confirmed?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ── taxonomy (@data/transformations/taxonomy.json, #2509 slice b) ─────────────

/** One verb of the fixed taxonomy: display metadata + the one-line hint of how that verb's
 *  invariants are typically checked. */
export interface TransformationVerbMeta {
  id: string;
  label: string;
  blurb: string;
  verification: string;
}

/** One composite recipe (migrate-to-kit · extract-and-abstract): the canonical steps the
 *  Transformations stage prompt's playbooks expand. */
export interface TransformationRecipeMeta {
  id: string;
  label: string;
  blurb: string;
  steps: string[];
}

/** One composition tier of the bottom-up confirm queue (0 primitives … 3 pages). */
export interface TransformationTierMeta {
  tier: number;
  label: string;
  blurb: string;
}

export interface TransformationTaxonomy {
  verbs: TransformationVerbMeta[];
  recipes: TransformationRecipeMeta[];
  tiers: TransformationTierMeta[];
}

// The config-dir copy (#2047) overlays the embedded default — editable without a rebuild.
export const TRANSFORMATION_TAXONOMY: TransformationTaxonomy =
  overlayFile("transformations/taxonomy.json", taxonomyEmbedded as TransformationTaxonomy);

/** The taxonomy's display metadata for one verb (label/blurb/verification — the blurb is the verb
 *  chip's tooltip), tolerant of a stale taxonomy file (an unknown id echoes back bare). */
export function verbMeta(id: string): TransformationVerbMeta {
  return (
    TRANSFORMATION_TAXONOMY.verbs.find((v) => v.id === id) ?? { id, label: id, blurb: "", verification: "" }
  );
}

/**
 * The `transformationsConfirmed` gate signal (#2509): the queue is non-empty AND every row is
 * confirmed. (The final "Completed UI" sign-off is the normal stage confirm on top of this.)
 */
export function transformationsConfirmed(rows: TransformationRow[] | null | undefined): boolean {
  return !!rows && rows.length > 0 && rows.every((r) => r.confirmed === true);
}

/** One tier of the confirm queue: its number + its rows in original list order. */
export interface TierGroup {
  tier: number;
  rows: TransformationRow[];
}

/**
 * Group rows by tier, tiers ascending (0 = primitives first), rows POSITION-STABLE within each
 * tier (list order is the planner's order — never re-sorted).
 */
export function tierGroups(rows: TransformationRow[]): TierGroup[] {
  const byTier = new Map<number, TransformationRow[]>();
  for (const r of rows) {
    const t = Number.isFinite(r.tier) ? r.tier : 0;
    const bucket = byTier.get(t);
    if (bucket) bucket.push(r);
    else byTier.set(t, [r]);
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, tierRows]) => ({ tier, rows: tierRows }));
}

/**
 * The current actionable tier: the LOWEST tier containing an unconfirmed row. `null` when the
 * queue is empty or fully confirmed (nothing pending — the completion card shows).
 */
export function nextPendingTier(rows: TransformationRow[]): number | null {
  let lowest: number | null = null;
  for (const r of rows) {
    if (r.confirmed === true) continue;
    const t = Number.isFinite(r.tier) ? r.tier : 0;
    if (lowest === null || t < lowest) lowest = t;
  }
  return lowest;
}

/**
 * Display label for a tier heading, driven by the taxonomy's tier ladder (#2509 slice b —
 * primitives → composites → layouts → pages): tier 0 is always the floor (the first taxonomy
 * tier), the TOP tier (when above 0) is the last (pages), and a middle tier reads its taxonomy
 * label clamped to the middle band — "Tier 0 · primitives" → "Tier 1 · composites" →
 * "Tier 2 · layouts" → "Tier N · pages".
 */
export function tierLabel(tier: number, maxTier: number): string {
  const tiers = TRANSFORMATION_TAXONOMY.tiers;
  const last = tiers.length - 1;
  const idx = tier <= 0 ? 0 : tier >= maxTier ? last : Math.min(tier, last - 1);
  const kind = tiers[idx]?.label;
  return kind ? `Tier ${tier} · ${kind}` : `Tier ${tier}`;
}

/**
 * Coerce the `bsc plan transformation list --json` blob into typed rows — a light structural
 * check (the CLI validates hard at write, #2395): anything that isn't an array of objects with a
 * string `id` is rejected; a missing/invalid `tier` reads as 0 so a partial row never breaks the
 * queue grouping.
 */
export function coerceTransformationRows(raw: unknown): TransformationRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => isRecord(r) && typeof r.id === "string")
    .map((r) => {
      const row = r as unknown as TransformationRow;
      return Number.isFinite(row.tier) ? row : { ...row, tier: 0 };
    });
}

/** Count the nodes of a render spec tree — the "spec present (n nodes)" fallback figure shown when the
 *  live render is unavailable.
 *
 *  Delegates to the SDK's own `visitNodes` rather than re-walking the tree here. #3500 moved slots into
 *  `props` (a Card's `header` used to be a top-level field), so a local walk that only descended
 *  top-level fields silently undercounted every nested slot — and a count that disagrees with the
 *  renderer about how many nodes a spec has is worse than no count. A tree that is not a valid node
 *  counts 0, which is exactly when the caller wants the fallback anyway. */
export function specNodeCount(spec: unknown): number {
  if (!isRecord(spec) || typeof spec.type !== "string") return 0;
  let count = 0;
  visitNodes(spec as unknown as GeneralNode, () => { count += 1; });
  return count;
}
