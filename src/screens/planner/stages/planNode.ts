// Pure helpers for the adaptive planning model (#201) — the typed-node tree.
//
// The plan is a tree of typed nodes (a `kind` + a `maturity` + children). The
// shape is derived for any project type (see shaping.ts) and deepened "as you go";
// `maturity` gates what's ready to become work, so depth lands where it buys
// parallelism (the seams) and stays shallow elsewhere. Layers are the top-level
// seams; a feature node at `contract-ready` is eligible to become a FeatureContract
// issue (#200).
//
// Free of React / xterm / Tauri imports so the logic is unit-testable in isolation
// (matches planSections.ts / featureContract.ts).
//
// Stable ids (#588 PS-ids): `mintNodeId` generates deterministic "{kind}-{hex}" ids
// for PlanNodes so the planner-sync merge engine can key tree nodes stably.
// Delegates to plannerCore/ids.ts for the canonical id derivation.

/**
 * Node kinds. **Extensible** — any string is valid so a project can name a kind it
 * needs; these are the well-known ones the UI/critic understand.
 */
export type NodeKind =
  | "layer"
  | "component"
  | "feature"
  | "contract"
  | "decision"
  | "risk"
  | "phase"
  | (string & {});

/** How fully specified a node is, from a one-line stub to ready-to-build. */
export type Maturity = "stub" | "sketched" | "specified" | "contract-ready";

/** Maturity in ascending order — index is the rank. */
export const MATURITY_ORDER: readonly Maturity[] = [
  "stub",
  "sketched",
  "specified",
  "contract-ready",
] as const;

/** Kinds that represent buildable work (eligible to become issues once ready). */
export const WORK_KINDS: readonly NodeKind[] = ["feature", "component"];

/** One node in the plan tree. */
export interface PlanNode {
  id: string;
  kind: NodeKind;
  title: string;
  maturity: Maturity;
  /** Optional one-liner / freeform content at this node. */
  summary?: string;
  children: PlanNode[];
}

// ── Maturity ─────────────────────────────────────────────────────────────────

/** Rank of a maturity (0..3). Unknown values rank as `stub` (0). */
export function maturityRank(m: Maturity): number {
  const i = MATURITY_ORDER.indexOf(m);
  return i < 0 ? 0 : i;
}

/** True when `m` is at least `min` on the maturity scale. */
export function atLeast(m: Maturity, min: Maturity): boolean {
  return maturityRank(m) >= maturityRank(min);
}

/** True when a node is ready to be turned into work. */
export function isContractReady(node: PlanNode): boolean {
  return node.maturity === "contract-ready";
}

// ── Traversal ────────────────────────────────────────────────────────────────

/** Depth-first walk (pre-order), visiting `node` then each descendant. */
export function walk(node: PlanNode, visit: (n: PlanNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) walk(child, visit, depth + 1);
}

/** All nodes in the subtree rooted at `node` (pre-order), including `node`. */
export function flatten(node: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  walk(node, (n) => out.push(n));
  return out;
}

/** Find a node by id anywhere in the subtree, or null. */
export function findNode(node: PlanNode, id: string): PlanNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// ── Gating + rollup ──────────────────────────────────────────────────────────

/**
 * Nodes eligible to be kicked off as issues: of a work kind (`feature`/`component`
 * by default) and `contract-ready`. This is the maturity gate — under-specified
 * nodes are never handed to an agent.
 */
export function kickableNodes(root: PlanNode, kinds: readonly NodeKind[] = WORK_KINDS): PlanNode[] {
  const allow = new Set(kinds);
  return flatten(root).filter((n) => allow.has(n.kind) && isContractReady(n));
}

/**
 * The effective maturity of a subtree: the **minimum** maturity across `node` and
 * all descendants — a layer is only as ready as its least-ready part. A leaf rolls
 * up to its own maturity.
 */
export function rollupMaturity(node: PlanNode): Maturity {
  let min = node.maturity;
  walk(node, (n) => {
    if (maturityRank(n.maturity) < maturityRank(min)) min = n.maturity;
  });
  return min;
}

/** Progress over a subtree: how many nodes are contract-ready, out of the total. */
export function progress(root: PlanNode): { ready: number; total: number; percent: number } {
  const all = flatten(root);
  const ready = all.filter(isContractReady).length;
  const total = all.length;
  return { ready, total, percent: total === 0 ? 0 : Math.round((ready / total) * 100) };
}

// ── Stable ids (#588 PS-ids) ──────────────────────────────────────────────────

export { nodeId as mintNodeId } from "../../../lib/planner/plannerCore/ids";
