// The tree layout (#3270) — a pure, deterministic placement of parent-pointer nodes for the SVG TreeView.
// Split out of the renderer so the renderer file exports only its component (fast-refresh) and the layout
// is unit-testable on its own. Works for any tree shape (a BST, or a complete binary heap): each LEAF takes
// the next horizontal slot; each internal node is CENTERED over its children; depth (distance from the
// root) drives the vertical position. Both axes are scaled + padded to fit a TREE_VIEW × TREE_VIEW viewBox.

/** The svg viewBox is VIEW × VIEW. */
export const TREE_VIEW = 320;
const PAD = 34; // inset so nodes don't touch the frame edge

/** The layout input — a node's stable id + its parent id (absent / out-of-set ⇒ a root). */
export interface LayoutNode {
  id: string;
  parent?: string;
}

/**
 * Place every node at `{ x, y }` in the viewBox. Leaves are laid left→right in child order; a parent sits
 * centered over the span of its children; `y` grows with depth from the root. Pure + deterministic — a
 * missing / dangling `parent` makes a node a root (multiple roots lay out left-to-right in one row band).
 * An empty input yields an empty map.
 */
export function treeLayout(nodes: readonly LayoutNode[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return pos;

  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  for (const n of nodes) children.set(n.id, []);
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parent !== undefined && ids.has(n.parent)) children.get(n.parent)!.push(n.id);
    else roots.push(n.id);
  }

  const depth = new Map<string, number>();
  const rawX = new Map<string, number>();
  let slot = 0;
  // Iterative post-order (an explicit stack avoids recursion-depth limits on a degenerate chain).
  const place = (rootId: string): void => {
    const stack: { id: string; d: number; phase: 0 | 1 }[] = [{ id: rootId, d: 0, phase: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = children.get(top.id) ?? [];
      if (top.phase === 0) {
        depth.set(top.id, top.d);
        top.phase = 1;
        // Descend into children first (they claim their x before the parent centers over them).
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], d: top.d + 1, phase: 0 });
      } else {
        stack.pop();
        if (kids.length === 0) rawX.set(top.id, slot++);
        else rawX.set(top.id, (rawX.get(kids[0])! + rawX.get(kids[kids.length - 1])!) / 2);
      }
    }
  };
  for (const r of roots) place(r);

  const maxX = Math.max(1, slot - 1);
  const maxD = Math.max(1, ...depth.values());
  const inner = TREE_VIEW - 2 * PAD;
  for (const n of nodes) {
    const rx = rawX.get(n.id) ?? 0;
    const d = depth.get(n.id) ?? 0;
    pos[n.id] = {
      x: slot <= 1 ? TREE_VIEW / 2 : PAD + (rx / maxX) * inner,
      y: PAD + (d / maxD) * inner,
    };
  }
  return pos;
}
