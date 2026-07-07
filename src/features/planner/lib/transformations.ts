// Transformations stage (#2509 slice a) — the pure data model behind the planner's transformations
// substrate: the modification counterpart to features. The planner decomposes a modification
// request into verb-shaped rows (`bsc plan transformation add`), the poll reflects the plan.db list
// into `planTransformations`, and the pane presents them as a BOTTOM-UP CONFIRM QUEUE (the settled
// presentation model): grouped by composition tier (0 = primitives … N = pages), only the lowest
// tier with pending work is actionable, and confirmation unlocks the next tier — so composites are
// generated against confirmed primitives and nothing is built on unreviewed foundations. An item is
// pending or confirmed, NOTHING ELSE (no rejections/exclusions — changes are described to the
// planner conversationally and the item re-presents). Pure (no React/Tauri) so it's unit-testable.

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
 *  (`tier`/`confirmed`) and the optional live-render `spec` (a KitNode tree). */
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
  /** A KitNode render spec (#1852) — rendered live through KitRenderer when present. */
  spec?: object;
  confirmed?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
 * Display label for a tier heading: tier 0 is always the primitives floor, the TOP tier (when
 * above 0) is the pages layer, everything between is a composite layer — "Tier 0 · primitives"
 * → "Tier 1 · composites" → … → "Tier N · pages".
 */
export function tierLabel(tier: number, maxTier: number): string {
  const kind = tier === 0 ? "primitives" : tier === maxTier ? "pages" : "composites";
  return `Tier ${tier} · ${kind}`;
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

/** Count the nodes of a KitNode spec tree (objects carrying a `kind`) — the "spec present
 *  (n nodes)" fallback figure when the live render is unavailable. */
export function specNodeCount(spec: unknown): number {
  if (!isRecord(spec) || typeof spec.kind !== "string") return 0;
  let count = 1;
  for (const [field, value] of Object.entries(spec)) {
    if (field === "kind") continue;
    if (Array.isArray(value)) {
      for (const child of value) count += specNodeCount(child);
    } else {
      count += specNodeCount(value);
    }
  }
  return count;
}
