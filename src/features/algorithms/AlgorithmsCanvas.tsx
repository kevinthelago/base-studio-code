// The world layer of the Algorithms knowledge graph (#2761) — the SVG edge layer + the node cards,
// positioned in world coords (GraphCanvas owns the pan/zoom transform). Selection lights a node + its
// neighbors and dims the rest; the kind filter dims whole columns. Edge geometry is the shared
// `graphEdge` grammar (perimeter-anchor routing, arrowheads, label midpoint) so this reads like every
// other graph in the app.
import { useMemo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import {
  KIND_META, REL_META, NODE_W, NODE_H, edgeId,
  type KnowledgeGraph, type KnowledgeKind, type KnowledgeLayout,
} from "./lib/knowledge";

interface EdgeGeom {
  id: string;
  rel: KnowledgeGraph["edges"][number]["rel"];
  from: string;
  to: string;
  d: string;
  arrow: string;
  arrowStart?: string;
  labelX: number;
  labelY: number;
}

interface CanvasProps {
  graph: KnowledgeGraph;
  layout: KnowledgeLayout;
  selected: string | null;
  /** The lit set (focus node + neighbors + incident edges) when something is selected, else null. */
  lit: { nodes: Set<string>; edges: Set<string> } | null;
  /** Kinds currently shown at full strength; a node of another kind is dimmed. */
  activeKinds: Set<KnowledgeKind>;
  /** Concept ids with an implementation in the active tech (#2770) — badged with a "</>" corner. */
  implConcepts?: Set<string>;
  onSelect: (id: string) => void;
}

export function AlgorithmsCanvas({ graph, layout, selected, lit, activeKinds, implConcepts, onSelect }: CanvasProps) {
  // Edge geometry is a function of the (stable) layout only — compute once. `bow` separates parallel
  // edges between the same pair so multiple relationships don't overdraw.
  const geoms = useMemo<EdgeGeom[]>(() => {
    const groups = new Map<string, number>();
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const counts = new Map<string, number>();
    for (const e of graph.edges) counts.set(pairKey(e.from, e.to), (counts.get(pairKey(e.from, e.to)) ?? 0) + 1);
    return graph.edges.flatMap((e) => {
      const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
      if (!a || !b) return [];
      const key = pairKey(e.from, e.to);
      const n = counts.get(key)!;
      const i = groups.get(key) ?? 0;
      groups.set(key, i + 1);
      const bow = n > 1 ? (i - (n - 1) / 2) * 20 : 0;
      const meta = REL_META[e.rel];
      const g = graphEdge(
        { x: a.x, y: a.y, w: NODE_W, h: NODE_H },
        { x: b.x, y: b.y, w: NODE_W, h: NODE_H },
        { routing: "anchor", bow, doubleEnded: meta.doubleEnded },
      );
      return [{ id: edgeId(e), rel: e.rel, from: e.from, to: e.to, ...g }];
    });
  }, [graph.edges, layout.pos]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const nodeActive = (id: string, kind: KnowledgeKind) =>
    activeKinds.has(kind) && (!lit || lit.nodes.has(id));

  return (
    <>
      <svg width={layout.world.w} height={layout.world.h} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        {geoms.map((g) => {
          const fromKind = byId.get(g.from)?.kind, toKind = byId.get(g.to)?.kind;
          const kindsShown = (!fromKind || activeKinds.has(fromKind)) && (!toKind || activeKinds.has(toKind));
          const isLit = !!lit && lit.edges.has(g.id);
          const dim = !kindsShown || (!!lit && !isLit);
          const stroke = isLit ? "var(--fg-dim)" : "var(--border)";
          return (
            <g key={g.id} style={{ opacity: dim ? 0.14 : 1, transition: "opacity 0.16s ease" }}>
              <path d={g.d} fill="none" stroke={stroke} strokeWidth={isLit ? 1.75 : 1.25}
                strokeDasharray={REL_META[g.rel].dashed ? "4 4" : undefined} />
              <path d={g.arrow} fill={stroke} />
              {g.arrowStart && <path d={g.arrowStart} fill={stroke} />}
              {isLit && (
                <text className="algo-edgelabel" x={g.labelX} y={g.labelY} textAnchor="middle" dominantBaseline="middle">
                  {REL_META[g.rel].label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {graph.nodes.map((n) => {
        const p = layout.pos.get(n.id);
        if (!p) return null;
        const active = nodeActive(n.id, n.kind);
        const meta = n.complexity ?? KIND_META[n.kind].label;
        return (
          <Box
            key={n.id}
            data-node={n.id}
            className={`algo-node${n.id === selected ? " on" : ""}${active ? "" : " dim"}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H, borderLeftColor: KIND_META[n.kind].color }}
            onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
          >
            <Box as="span" className="algo-name">{n.name}</Box>
            <Box as="span" className="algo-meta">{meta}</Box>
            {implConcepts?.has(n.id) && <Box as="span" className="algo-impl-badge mono" title="Has an implementation in the active language">{"</>"}</Box>}
          </Box>
        );
      })}
    </>
  );
}
