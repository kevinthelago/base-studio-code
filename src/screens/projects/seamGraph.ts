// Per-repo seam/contract graph (#NNN): derive a renderable producer→consumer DAG from a
// set of FeatureContracts. A feature that `produces` contract X and one that `consumes` X
// form an edge X: A→B — the seam between them. Nodes are topologically layered (layer 0 =
// a producer with no inbound seam; higher layers are closer to the final product), so a
// renderer can lay the path-to-product out left→right. Dangling/duplicate seams are
// surfaced via the existing validateContracts. Pure (no UI) so it's fully testable.
import { type FeatureContract, validateContracts, type ContractValidation } from "./featureContract";

export interface SeamNode {
  id: string;
  /** The feature's title. */
  label: string;
  stream?: string;
  /** Topological layer: 0 = no inbound seam; higher = closer to the product. */
  layer: number;
}

export interface SeamEdge {
  /** Producer feature id. */
  from: string;
  /** Consumer feature id. */
  to: string;
  /** The seam (produced/consumed contract name). */
  contract: string;
}

export interface SeamGraph {
  nodes: SeamNode[];
  edges: SeamEdge[];
  /** Node ids grouped by layer index — the left→right columns for layout. */
  layers: string[][];
  /** Reused critic output: dangling consumes / duplicate produces / unknown deps. */
  validation: ContractValidation;
}

/** Longest-path layer per node (cycle-safe: a node in a cycle resolves to a source). */
function layerNodes(ids: string[], edges: SeamEdge[]): Map<string, number> {
  const preds = new Map<string, string[]>();
  for (const id of ids) preds.set(id, []);
  for (const e of edges) preds.get(e.to)?.push(e.from);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0; // cycle guard — treat as a source
    visiting.add(id);
    const ps = preds.get(id) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depth));
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  return layer;
}

/**
 * Build the seam DAG for a set of features. An edge A→B labelled `X` means A `produces`
 * contract X and B `consumes` it. A consume with no producer is omitted from the edges
 * (and shows up in `validation.dangling`); a self-consume is ignored.
 */
export function buildSeamGraph(features: FeatureContract[], idByRef: Record<string, string> = {}): SeamGraph {
  // First producer wins as the owner of each contract name.
  const producerOf = new Map<string, string>();
  for (const f of features) {
    for (const p of f.produces) {
      if (!producerOf.has(p.name)) producerOf.set(p.name, f.id);
    }
  }

  const edges: SeamEdge[] = [];
  for (const f of features) {
    for (const c of f.consumes) {
      const from = producerOf.get(c.name);
      if (from && from !== f.id) edges.push({ from, to: f.id, contract: c.name });
    }
  }

  const ids = features.map((f) => f.id);
  const layer = layerNodes(ids, edges);
  const nodes: SeamNode[] = features.map((f) => ({
    id: f.id,
    label: f.title,
    stream: f.stream,
    layer: layer.get(f.id) ?? 0,
  }));

  const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer), 0);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[n.layer].push(n.id);

  return { nodes, edges, layers, validation: validateContracts(features, idByRef) };
}
