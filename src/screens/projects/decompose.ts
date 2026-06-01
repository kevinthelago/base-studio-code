// Decompose (#228) — the bridge where the planning model (#201) meets the
// FeatureContract (#200). Walk the plan tree, take the contract-ready feature/
// component nodes (the maturity gate), and emit a FeatureContract skeleton for each:
// id/title/goal from the node, `owns` from its nearest layer ancestor, `dependsOn`
// from an optional edge map. The output renders to issue bodies
// (`renderFeatureContract`) and feeds the publish adapter (#226).
//
// Pure transform. Free of React / xterm / Tauri imports.

import { kickableNodes, type PlanNode, type NodeKind } from "./planNode";
import type { FeatureContract } from "./featureContract";

export interface DecomposeOptions {
  /** Gate command(s) for each contract's verification (e.g. ["npm test"]). */
  gate?: string[];
  /** feature node id → issue refs it depends on (usually contract owners). */
  dependsOn?: Record<string, string[]>;
  /** layer id → owned path globs (from the shape/config). */
  ownsByLayer?: Record<string, string[]>;
  /** Which kinds are decomposed into contracts (default: feature + component). */
  kinds?: readonly NodeKind[];
}

/** Map every node id to its nearest ancestor `layer` id (prefix-stripped). */
function layerOwnerMap(plan: PlanNode): Map<string, string> {
  const map = new Map<string, string>();
  const dfs = (node: PlanNode, currentLayer: string | null) => {
    const layer = node.kind === "layer" ? node.id.replace(/^layer:/, "") : currentLayer;
    if (layer) map.set(node.id, layer);
    for (const child of node.children) dfs(child, layer);
  };
  dfs(plan, null);
  return map;
}

/**
 * Turn a plan tree's **contract-ready** work nodes into FeatureContract skeletons —
 * one per `kickableNodes` entry. Populates what's derivable from the node + options;
 * the seam fields (`consumes`/`produces`) and acceptance detail are left as minimal
 * placeholders for the planner/agent to fill before the contract is finalized.
 */
export function decompose(plan: PlanNode, opts: DecomposeOptions = {}): FeatureContract[] {
  const layerOf = layerOwnerMap(plan);
  return kickableNodes(plan, opts.kinds).map((node) => {
    const layer = layerOf.get(node.id);
    return {
      id: node.id,
      title: node.title,
      goal: node.summary ?? `Implement ${node.title}.`,
      acceptance: [`${node.title} works as specified`],
      owns: layer ? opts.ownsByLayer?.[layer] ?? [] : [],
      consumes: [],
      produces: [],
      verification: { tests: [], gate: opts.gate ?? [] },
      dependsOn: opts.dependsOn?.[node.id] ?? [],
      ...(layer ? { stream: layer } : {}),
    };
  });
}
