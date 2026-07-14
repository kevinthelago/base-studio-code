// The Sounds composition graph canvas (#3077) — world-positioned node cards over an SVG edge layer, the
// same shape as AlgorithmsKitGraph (GraphCanvas owns the pan/zoom transform). Nodes are the kit's
// primitives / voices / cues; edges are `composes`. Clicking a node ACTIVATES it (select + play, via the
// workspace). Selection lights a node + its neighbours and dims the rest.
import { useMemo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { NODE_W, NODE_H, type SoundGraph, type SoundLayout } from "./lib/soundGraph";

interface EdgeGeom { id: string; d: string; arrow: string; labelX: number; labelY: number }

export function SoundsKitGraph({ graph, layout, selected, onActivate }: {
  graph: SoundGraph;
  layout: SoundLayout;
  /** The selected node id, or null. */
  selected: string | null;
  /** Select + play the node (the workspace decides what "play" means per kind). */
  onActivate: (id: string) => void;
}) {
  // Neighbours of the selection (either direction) + incident edges — the shared "focus dims the rest".
  const lit = useMemo(() => {
    if (!selected) return null;
    const nodes = new Set<string>([selected]);
    const edges = new Set<string>();
    for (const e of graph.edges) {
      if (e.from === selected) { nodes.add(e.to); edges.add(e.id); }
      if (e.to === selected) { nodes.add(e.from); edges.add(e.id); }
    }
    return { nodes, edges };
  }, [graph.edges, selected]);

  const geoms = useMemo<EdgeGeom[]>(() => {
    return graph.edges.flatMap((e) => {
      const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
      if (!a || !b) return [];
      const g = graphEdge(
        { x: a.x, y: a.y, w: NODE_W, h: NODE_H },
        { x: b.x, y: b.y, w: NODE_W, h: NODE_H },
        { routing: "anchor" },
      );
      return [{ id: e.id, d: g.d, arrow: g.arrow, labelX: g.labelX, labelY: g.labelY }];
    });
  }, [graph.edges, layout.pos]);

  return (
    <>
      <svg width={layout.world.w} height={layout.world.h} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        {geoms.map((g) => {
          const isLit = !!lit && lit.edges.has(g.id);
          const dim = !!lit && !isLit;
          const stroke = isLit ? "var(--fg-dim)" : "var(--border)";
          return (
            <g key={g.id} style={{ opacity: dim ? 0.14 : 1, transition: "opacity 0.16s ease" }}>
              <path d={g.d} fill="none" stroke={stroke} strokeWidth={isLit ? 1.75 : 1.25} />
              <path d={g.arrow} fill={stroke} />
            </g>
          );
        })}
      </svg>

      {graph.nodes.map((n) => {
        const p = layout.pos.get(n.id);
        if (!p) return null;
        const dim = !!lit && !lit.nodes.has(n.id);
        return (
          <Box
            key={n.id}
            data-snd-node={n.id}
            className={`snd-node snd-${n.kind}${n.id === selected ? " on" : ""}${dim ? " dim" : ""}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            onClick={(e) => { e.stopPropagation(); onActivate(n.id); }}
          >
            <Box as="span" className="snd-name">{n.label}</Box>
            <Box as="span" className="snd-meta mono">{n.category ?? n.kind}</Box>
          </Box>
        );
      })}
    </>
  );
}
