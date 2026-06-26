// Per-repo seam/contract DAG builder (#294). Pure (no React / Tauri) so the
// builder and layout are unit-testable. NOTE: the Structure pane's seam-graph
// visualization was removed in favor of the agent-relationship swimlane
// (relationshipGraph.ts / RelationshipGraphView.tsx); this builder is retained
// for its tests.
//
// When full FeatureContract seam data is available the graph shows produce→consume
// edges; without it (the common case for projects that haven't authored explicit
// contracts) the graph falls back to `PlanIssue.dependsOn` dependency edges —
// still a useful topological picture of the build order.

import type { PlanIssue } from "@/features/planner/issues/planIssues";

// ── Node maturity ─────────────────────────────────────────────────────────────

/** Visual maturity derived from the issue's current state. */
export type NodeMaturity = "stub" | "backlog" | "active" | "done";

function maturityOf(issue: PlanIssue): NodeMaturity {
  if (issue.labels.some(l => /^(done|closed)$/i.test(l))) return "done";
  if (issue.acceptance.length >= 2 && issue.owns.length > 0) return "active";
  if (issue.acceptance.length > 0 || issue.owns.length > 0) return "backlog";
  return "stub";
}

// ── Graph types ───────────────────────────────────────────────────────────────

/** One feature/issue node in the seam graph. */
export interface SeamNode {
  /** Issue ref (the stable planner-local id). */
  id: string;
  title: string;
  stream?: string;
  phase?: number | string;
  maturity: NodeMaturity;
  /** Files/dirs this issue owns (from PlanIssue.owns); used for the drill-down panel. */
  owns: string[];
  /** Acceptance criteria (from PlanIssue.acceptance); used for the drill-down panel. */
  acceptance: string[];
  /** Topological layer: 0 = sources (no upstream deps), higher = later. */
  layer: number;
  /** Position within the layer (0-based). */
  order: number;
}

/** A directed dependency edge: `from` is upstream of `to`. */
export interface SeamEdge {
  from: string;   // upstream issue ref
  to:   string;   // downstream issue ref
  /** True when `from` doesn't resolve to any node in this graph (dangling dep). */
  dangling: boolean;
}

export interface SeamGraph {
  nodes:        SeamNode[];
  edges:        SeamEdge[];
  /** Total number of topological layers. */
  layerCount:   number;
  /** Edges where the upstream node is absent from the set. */
  danglingCount: number;
}

// ── Graph builder ─────────────────────────────────────────────────────────────

/**
 * Build a seam graph from a set of `PlanIssue`s:
 * - **Nodes** — one per issue, carrying title/stream/phase/maturity/owns/acceptance.
 * - **Edges** — from `issue.dependsOn` links. Missing deps become dangling edges.
 * - **Layout** — topological layers via Kahn's algorithm (longest path to a source),
 *   so dependency order reads left-to-right.
 *
 * `filterRepo` restricts the graph to one repo's issues; cross-repo edges that leave
 * the visible set are marked dangling so they're highlighted rather than silently
 * dropped.
 */
export function buildSeamGraph(issues: PlanIssue[], filterRepo?: string): SeamGraph {
  const visible = filterRepo
    ? issues.filter(i => i.repo === filterRepo)
    : issues;

  const nodeSet = new Set(visible.map(i => i.ref));

  // ── edges ─────────────────────────────────────────────────────────────────
  const edges: SeamEdge[] = [];
  for (const issue of visible) {
    for (const dep of issue.dependsOn) {
      edges.push({ from: dep, to: issue.ref, dangling: !nodeSet.has(dep) });
    }
  }

  // ── topological layer assignment (Kahn's algorithm, longest-path variant) ──
  // layer(n) = max(layer(upstream)) + 1. Sources land in layer 0.
  const incomingEdges = new Map<string, string[]>(); // node → upstream refs
  for (const n of visible) incomingEdges.set(n.ref, []);
  for (const e of edges) {
    if (!e.dangling) {
      const list = incomingEdges.get(e.to) ?? [];
      list.push(e.from);
      incomingEdges.set(e.to, list);
    }
  }

  const layerOf = new Map<string, number>();
  const queue: string[] = [];

  for (const n of visible) {
    if ((incomingEdges.get(n.ref) ?? []).length === 0) {
      layerOf.set(n.ref, 0);
      queue.push(n.ref);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const curLayer = layerOf.get(cur) ?? 0;
    for (const e of edges) {
      if (e.from === cur && !e.dangling) {
        const existing = layerOf.get(e.to) ?? -1;
        const proposed = curLayer + 1;
        if (proposed > existing) {
          layerOf.set(e.to, proposed);
          queue.push(e.to);
        }
      }
    }
  }

  // Nodes not reached by the BFS (cycles or disconnected) fall to layer 0.
  for (const n of visible) {
    if (!layerOf.has(n.ref)) layerOf.set(n.ref, 0);
  }

  // ── order within each layer ───────────────────────────────────────────────
  const byLayer = new Map<number, string[]>();
  for (const [ref, layer] of layerOf) {
    const list = byLayer.get(layer) ?? [];
    list.push(ref);
    byLayer.set(layer, list);
  }
  const issueByRef = new Map(visible.map(i => [i.ref, i]));
  for (const list of byLayer.values()) {
    list.sort((a, b) => {
      const ia = issueByRef.get(a), ib = issueByRef.get(b);
      const sa = ia?.stream ?? "", sb = ib?.stream ?? "";
      return sa !== sb ? sa.localeCompare(sb) : a.localeCompare(b);
    });
  }
  const orderOf = new Map<string, number>();
  for (const list of byLayer.values()) {
    list.forEach((ref, i) => orderOf.set(ref, i));
  }

  // ── assemble nodes ────────────────────────────────────────────────────────
  const nodes: SeamNode[] = visible.map(issue => ({
    id:         issue.ref,
    title:      issue.title,
    stream:     issue.stream,
    phase:      issue.phase,
    maturity:   maturityOf(issue),
    owns:       issue.owns,
    acceptance: issue.acceptance,
    layer:      layerOf.get(issue.ref) ?? 0,
    order:      orderOf.get(issue.ref) ?? 0,
  }));

  const layerCount    = byLayer.size;
  const danglingCount = edges.filter(e => e.dangling).length;
  return { nodes, edges, layerCount, danglingCount };
}
