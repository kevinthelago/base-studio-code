// The kits-index layer of the Algorithms graph (#2863) — "the layer above the graph": one world-positioned
// card per language kit (TypeScript · Rust · Java…), each summarizing its primitive/algorithm counts.
// Clicking a card drills into that kit's concept+primitive graph (the AlgorithmsCanvas layer). Mirrors the
// AlgorithmsCanvas idiom (absolute cards in world coords; GraphCanvas owns the pan/zoom transform) so the
// two layers read as one graph the user zooms between.
import { Box } from "@/shared/ui/layout/Box";
import {
  KIT_W, KIT_H, TECH_META, kitTechs, kitImplsByRole,
  type KnowledgeGraph, type KitsLayout, type Tech,
} from "./lib/knowledge";

export function AlgorithmsKitsCanvas({ graph, layout, activeTech, onOpen }: {
  graph: KnowledgeGraph;
  layout: KitsLayout;
  /** The active kit — its card reads as selected so the user keeps their place across the drill. */
  activeTech: Tech;
  /** Drill into a kit's graph. */
  onOpen: (tech: Tech) => void;
}) {
  return (
    <>
      {kitTechs(graph).map((t) => {
        const p = layout.pos.get(t);
        if (!p) return null;
        const prims = kitImplsByRole(graph, t, "primitive").length;
        const algos = kitImplsByRole(graph, t, "algorithm").length;
        return (
          <Box
            key={t}
            data-kit={t}
            className={`algo-kit${t === activeTech ? " on" : ""}`}
            style={{ left: p.x, top: p.y, width: KIT_W, height: KIT_H }}
            onClick={(e) => { e.stopPropagation(); onOpen(t); }}
          >
            <Box as="span" className="algo-kit-name">{TECH_META[t]?.label ?? t}</Box>
            <Box as="span" className="algo-kit-meta mono">{prims} primitives · {algos} algorithms</Box>
            <Box as="span" className="algo-kit-open mono">open →</Box>
          </Box>
        );
      })}
    </>
  );
}
