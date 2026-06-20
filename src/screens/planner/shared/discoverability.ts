// Planning discoverability (#205) — surface the right thing at the right moment, so
// neither the user nor the planning agent misses what they should have considered.
// Three axes:
//
//   - Missing   — the critic, run continuously: `findGaps`.
//   - Relevant  — node-scoped retrieval ranking: `rankRelevant`.
//   - Connected — navigate the growing plan: `searchNodes`.
//
// The discipline: only HIGH-confidence gaps are PUSHed (a quiet, non-blocking
// signal); everything else is PULL. Pure model core — the UI affordances build on
// it. Free of React / xterm / Tauri imports (matches planNode/shape/shaping).

import { flatten, type PlanNode } from "../planNode";
import { validateShapePolicy, type Shape } from "../data/shape";
import { DIMENSIONS, type DimensionId } from "../data/shaping";

// ── Missing: the continuous gap critic ─────────────────────────────────────────

/** Pushed = surfaced proactively (high-confidence). Pull = available on demand. */
export type GapSeverity = "push" | "pull";

export type GapKind =
  | "policy-layer"
  | "policy-contract"
  | "unaddressed-dimension"
  | "underspecified"
  | "external";

export interface Gap {
  kind: GapKind;
  severity: GapSeverity;
  title: string;
  detail?: string;
  /** Plan node this concerns, if any. */
  nodeId?: string;
  /** Where it came from — which check or source. */
  provenance: string;
}

export interface GapInput {
  plan: PlanNode;
  /** The effective (composed) shape, for policy enforcement. */
  shape?: Shape;
  /** Dimensions the project answered "yes" to. */
  answeredDimensions?: DimensionId[];
  /** Contract names present per layer id — enables policy-contract checks. */
  presentContractsByLayer?: Record<string, Iterable<string>>;
  /** Gaps computed elsewhere (e.g. dangling contracts from validateContracts, #200). */
  externalGaps?: Gap[];
}

/** The plan's present layer ids (the part after the `layer:` node-id prefix). */
function presentLayerIds(plan: PlanNode): string[] {
  return flatten(plan)
    .filter((n) => n.kind === "layer")
    .map((n) => n.id.replace(/^layer:/, ""));
}

/**
 * Run the structural critic over the plan and return gaps. High-confidence,
 * actionable holes (policy violations, declared-but-unaddressed dimensions) are
 * `push`; soft suggestions (still-stub layers) are `pull`. External gaps (e.g. a
 * dangling consume from #200's `validateContracts`) are folded in as given.
 */
export function findGaps(input: GapInput): Gap[] {
  const gaps: Gap[] = [];
  const present = presentLayerIds(input.plan);
  const presentSet = new Set(present);

  // Policy coverage (the mandatory tier). Without a contract map we only assert
  // layer coverage — contract-level policy needs the caller to pass contract presence.
  if (input.shape) {
    const violations = validateShapePolicy(
      input.shape,
      present,
      input.presentContractsByLayer ?? {},
    ).filter((v) => (input.presentContractsByLayer ? true : v.kind === "layer"));
    for (const v of violations) {
      gaps.push(
        v.kind === "layer"
          ? {
              kind: "policy-layer",
              severity: "push",
              title: `Required layer "${v.layer}" is missing`,
              nodeId: `layer:${v.layer}`,
              provenance: "shape policy",
            }
          : {
              kind: "policy-contract",
              severity: "push",
              title: `Layer "${v.layer}" is missing required contract "${v.contract}"`,
              nodeId: `layer:${v.layer}`,
              provenance: "shape policy",
            },
      );
    }
  }

  // Declared dimensions with no layer addressing them.
  for (const dimId of input.answeredDimensions ?? []) {
    const dim = DIMENSIONS.find((d) => d.id === dimId);
    if (!dim) continue;
    const addressed = dim.layers.some((l) => presentSet.has(l));
    if (!addressed) {
      gaps.push({
        kind: "unaddressed-dimension",
        severity: "push",
        title: `"${dimId}" was declared but no layer addresses it`,
        detail: `Expected one of: ${dim.layers.join(", ")}`,
        provenance: "dimension probe",
      });
    }
  }

  // Soft: layers still at stub maturity (a pull-only nudge to elaborate).
  for (const node of flatten(input.plan)) {
    if (node.kind === "layer" && node.maturity === "stub") {
      gaps.push({
        kind: "underspecified",
        severity: "pull",
        title: `"${node.title}" is still a stub`,
        nodeId: node.id,
        provenance: "maturity",
      });
    }
  }

  if (input.externalGaps) gaps.push(...input.externalGaps);
  return gaps;
}

/** Split gaps into the proactive (push) and on-demand (pull) sets. */
export function partitionGaps(gaps: Gap[]): { push: Gap[]; pull: Gap[] } {
  const push: Gap[] = [];
  const pull: Gap[] = [];
  for (const g of gaps) (g.severity === "push" ? push : pull).push(g);
  return { push, pull };
}

/** Rank order for pushed gaps — most-actionable first. */
const GAP_PRIORITY: Record<GapKind, number> = {
  "policy-layer": 0,
  "policy-contract": 1,
  "unaddressed-dimension": 2,
  external: 3,
  underspecified: 4,
};

/**
 * The pushed gaps, ranked by actionability and **capped** — discoverability never
 * fire-hoses. Pull gaps stay available but aren't returned here.
 */
export function topGaps(gaps: Gap[], cap = 5): Gap[] {
  return partitionGaps(gaps)
    .push.slice()
    .sort((a, b) => GAP_PRIORITY[a.kind] - GAP_PRIORITY[b.kind])
    .slice(0, cap);
}

// ── Relevant: node-scoped retrieval ranking ────────────────────────────────────

/** A candidate item to surface (KB block, prior contract, archetype, MCP template…). */
export interface Candidate {
  id: string;
  tags: string[];
  title?: string;
  provenance?: string;
}

export interface RankedCandidate extends Candidate {
  score: number;
}

/** The terms that describe a node: its kind + the words in its title/summary. */
function nodeTerms(node: PlanNode): Set<string> {
  const text = `${node.kind} ${node.title} ${node.summary ?? ""}`.toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Rank candidates by relevance to a node — overlap between the candidate's tags and
 * the node's terms (kind + title + summary). Returns only matches (score > 0),
 * highest first, **capped**. Stable tie-break by id.
 */
export function rankRelevant(
  node: PlanNode,
  candidates: Candidate[],
  cap = 5,
): RankedCandidate[] {
  const terms = nodeTerms(node);
  return candidates
    .map((c) => ({ ...c, score: c.tags.filter((t) => terms.has(t.toLowerCase())).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
    .slice(0, cap);
}

// ── Connected: navigate the plan ───────────────────────────────────────────────

/**
 * Case-insensitive search over the plan's node titles + summaries. Returns matching
 * nodes pre-order. (Maturity/kind filtering is a plain `flatten(...).filter(...)`.)
 */
export function searchNodes(plan: PlanNode, query: string): PlanNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return flatten(plan).filter((n) =>
    `${n.title} ${n.summary ?? ""}`.toLowerCase().includes(q),
  );
}
