// The `tree` structure renderer (#3270, epic #3171) — a `StructureRenderer<"tree">` that draws a TreeFrame
// (a tree, or a heap/BST) as an SVG node-link diagram, laid out by `treeLayout` from the parent pointers.
// Durable node state comes from the frame's `marks` (static colours in treeView.css); the transient verbs
// (visit / insert / swap-sift / compare on a node) are stamped as `data-op` and animate via the
// designer-authored KitAnimation data (`treeViewMotion.ts`). Like the other renderers, it only stamps
// state — never writes animation CSS.
import { useEffect } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { markStateAttrs, nodeOpStateAttrs } from "../../lib/binding";
import type { TreeFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import { TREE_VIZ_ANIM_CLASSES, ensureTreeViewMotion } from "./treeViewMotion";
import { treeLayout, TREE_VIEW as VIEW } from "./treeLayout";
import "./treeView.css";

const NODE_R = 16;

export const TreeView: StructureRenderer<"tree"> = ({ frame }: { frame: TreeFrame }) => {
  useEffect(() => {
    ensureTreeViewMotion();
  }, []);

  const { nodes, ops, marks } = frame;
  const pos = treeLayout(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Node-addressed verbs only (visit/insert/remove/compare/swap name a node or an `at` id pair); a `rotate`
  // names a pivot and is left to the renderer (unused by the heap demonstrator).
  const nodeOps = (ops ?? []).filter((o) => o.op !== "rotate");

  return (
    <Box className={`tree-view ${TREE_VIZ_ANIM_CLASSES}`} role="img" aria-label="tree">
      {nodes.length === 0 ? (
        <Box className="tree-empty" aria-label="empty">
          (empty)
        </Box>
      ) : (
        <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="tree-svg" role="presentation">
          {nodes.map((nd) => {
            const p = pos[nd.id];
            const parent = nd.parent !== undefined ? byId.get(nd.parent) : undefined;
            const pp = parent ? pos[parent.id] : undefined;
            if (!p || !pp) return null;
            return <line key={`e-${nd.id}`} className="tree-edge" x1={pp.x} y1={pp.y} x2={p.x} y2={p.y} />;
          })}
          {nodes.map((nd) => {
            const p = pos[nd.id];
            if (!p) return null;
            // data-op/data-mark ride the CIRCLE, not the <g> (the <g> owns the position transform; a kit
            // animation's own `transform` would otherwise clobber the translate). Mirrors GraphView.
            const attrs = { ...nodeOpStateAttrs(nodeOps, nd.id), ...markStateAttrs(marks, nd.id) };
            return (
              <g key={nd.id} transform={`translate(${p.x} ${p.y})`}>
                <circle className="tree-node" r={NODE_R} {...attrs} />
                <text className="tree-node-label" textAnchor="middle" dominantBaseline="central">
                  {nd.value}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </Box>
  );
};
