// The per-kit graph canvas (#2863) — a language kit's OWN graph: nodes are its implementations (a
// concept IS its implementation), wired by `composes` (builds-on) + `pairs` + the ontology's semantic
// relationships lifted onto the concrete impls. World-positioned impl cards over an SVG edge layer,
// mirroring AlgorithmsCanvas' idiom (GraphCanvas owns the pan/zoom transform) so it reads like every
// other graph. Selection lights a node + its neighbors; the role tints the card (primitive vs algorithm).
import { useMemo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { KIT_REL_META, NODE_W, NODE_H, type KitGraph, type KitRel, type KnowledgeLayout } from "./lib/knowledge";

interface KitEdgeGeom { id: string; rel: KitRel; from: string; to: string; d: string; arrow: string; arrowStart?: string; labelX: number; labelY: number }

export function AlgorithmsKitGraph({ kit, layout, selected, onSelect }: {
  kit: KitGraph;
  layout: KnowledgeLayout;
  /** The selected implementation id, or null. */
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  // Neighbors of the selection (either direction) + the incident edges — the shared "focus dims the rest".
  const lit = useMemo(() => {
    if (!selected) return null;
    const nodes = new Set<string>([selected]);
    const edges = new Set<string>();
    for (const e of kit.edges) {
      const id = `${e.from}~${e.rel}~${e.to}`;
      if (e.from === selected) { nodes.add(e.to); edges.add(id); }
      if (e.to === selected) { nodes.add(e.from); edges.add(id); }
    }
    return { nodes, edges };
  }, [kit.edges, selected]);

  // Edge geometry — bow parallel edges between the same pair apart so they don't overdraw.
  const geoms = useMemo<KitEdgeGeom[]>(() => {
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const counts = new Map<string, number>();
    for (const e of kit.edges) counts.set(pairKey(e.from, e.to), (counts.get(pairKey(e.from, e.to)) ?? 0) + 1);
    const seen = new Map<string, number>();
    return kit.edges.flatMap((e) => {
      const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
      if (!a || !b) return [];
      const key = pairKey(e.from, e.to);
      const n = counts.get(key)!;
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      const bow = n > 1 ? (i - (n - 1) / 2) * 20 : 0;
      const meta = KIT_REL_META[e.rel];
      const g = graphEdge(
        { x: a.x, y: a.y, w: NODE_W, h: NODE_H },
        { x: b.x, y: b.y, w: NODE_W, h: NODE_H },
        { routing: "anchor", bow, doubleEnded: meta.doubleEnded },
      );
      return [{ id: `${e.from}~${e.rel}~${e.to}`, rel: e.rel, from: e.from, to: e.to, ...g }];
    });
  }, [kit.edges, layout.pos]);

  return (
    <>
      <svg width={layout.world.w} height={layout.world.h} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        {geoms.map((g) => {
          const isLit = !!lit && lit.edges.has(g.id);
          const dim = !!lit && !isLit;
          const stroke = isLit ? "var(--fg-dim)" : "var(--border)";
          return (
            <g key={g.id} style={{ opacity: dim ? 0.14 : 1, transition: "opacity 0.16s ease" }}>
              <path d={g.d} fill="none" stroke={stroke} strokeWidth={isLit ? 1.75 : 1.25}
                strokeDasharray={KIT_REL_META[g.rel].dashed ? "4 4" : undefined} />
              <path d={g.arrow} fill={stroke} />
              {g.arrowStart && <path d={g.arrowStart} fill={stroke} />}
              {isLit && (
                <text className="algo-edgelabel" x={g.labelX} y={g.labelY} textAnchor="middle" dominantBaseline="middle">
                  {KIT_REL_META[g.rel].label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {kit.nodes.map((im) => {
        const p = layout.pos.get(im.id);
        if (!p) return null;
        const dim = !!lit && !lit.nodes.has(im.id);
        return (
          <Box
            key={im.id}
            data-impl={im.id}
            className={`algo-node${im.id === selected ? " on" : ""}${dim ? " dim" : ""}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            onClick={(e) => { e.stopPropagation(); onSelect(im.id); }}
          >
            <Box as="span" className="algo-name">{im.name}</Box>
            <Box as="span" className="algo-meta mono">{im.id}</Box>
          </Box>
        );
      })}
    </>
  );
}
