// The `graph` structure renderer (#3224, epic #3220) — a `StructureRenderer<"graph">` that draws a
// GraphFrame as an SVG node-link diagram on a circular layout. Node search state comes from the frame's
// durable `marks` (static colours in graphView.css); the transient verbs (visit / frontier on a node,
// relax on an edge) are stamped as `data-op` and animate via the designer-authored KitAnimation data
// (`graphViewMotion.ts`). Like the other renderers, it only stamps state — never writes animation CSS.
import { useEffect } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { markStateAttrs, nodeOpStateAttrs } from "../../lib/binding";
import type { GraphFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import { GRAPH_VIZ_ANIM_CLASSES, ensureGraphViewMotion } from "./graphViewMotion";
import { circularLayout, GRAPH_VIEW as VIEW } from "./graphLayout";
import "./graphView.css";

const NODE_R = 19;

/** An undirected edge key so a relaxed edge matches regardless of endpoint order. */
const edgeKey = (a: string, b: string) => [a, b].slice().sort().join("~");

export const GraphView: StructureRenderer<"graph"> = ({ frame }: { frame: GraphFrame }) => {
  useEffect(() => {
    ensureGraphViewMotion();
  }, []);

  const { nodes, edges, ops, marks } = frame;
  const pos = circularLayout(nodes.map((n) => n.id));
  // The edges relaxed THIS frame (undirected) — stamped data-op="relax" so they flash.
  const relaxed = new Set(
    (ops ?? [])
      .filter((o): o is { op: "relax"; edge: [string, string] } => o.op === "relax")
      .map((o) => edgeKey(o.edge[0], o.edge[1])),
  );
  // A `path` op (Dijkstra / topological result) lights its route — flash each consecutive edge (reuse relax).
  for (const o of ops ?? []) {
    if (o.op === "path") {
      const seq = (o as { nodes: string[] }).nodes;
      for (let i = 0; i < seq.length - 1; i++) relaxed.add(edgeKey(seq[i], seq[i + 1]));
    }
  }
  // Nodes stamp only from node-addressed verbs (visit/frontier); relax animates the EDGE, not its endpoints.
  const nodeOps = (ops ?? []).filter((o) => o.op === "visit" || o.op === "frontier");

  return (
    <Box className={`graph-view ${GRAPH_VIZ_ANIM_CLASSES}`} role="img" aria-label="graph">
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="graph-svg" role="presentation">
        {edges.map((e) => {
          const a = pos[e.from];
          const b = pos[e.to];
          if (!a || !b) return null;
          const on = relaxed.has(edgeKey(e.from, e.to));
          const weighted = e.weight !== undefined && e.weight !== 1;
          return (
            <g key={`${e.from}-${e.to}`}>
              <line className="graph-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...(on ? { "data-op": "relax" } : {})} />
              {weighted && (
                <text className="graph-weight" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} textAnchor="middle" dominantBaseline="central">
                  {e.weight}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((nd) => {
          const p = pos[nd.id];
          if (!p) return null;
          const attrs = { ...nodeOpStateAttrs(nodeOps, nd.id), ...markStateAttrs(marks, nd.id) };
          return (
            <g key={nd.id} transform={`translate(${p.x} ${p.y})`}>
              <circle className="graph-node" r={NODE_R} {...attrs} />
              <text className="graph-node-label" textAnchor="middle" dominantBaseline="central">
                {nd.label ?? nd.id}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
};
