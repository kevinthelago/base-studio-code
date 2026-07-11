// Pure KitNode tree helpers (#2868) — depth-first traversal + derived collections over a spec tree.
// No React; the interaction-defaults host (SelfWiredKitRenderer) and future behavior slices read from
// here. The children-bearing kinds are `card` (its `header` + `children`) and `row` (`children`),
// matching the contract in `@data/ui/kit-nodes.json`; every other kind is a leaf.

import type { KitNode } from "./schema";

/** Visit every node in a KitNode tree depth-first (self, then a card's header + children / a row's
 *  children). Pure — the visitor sees each node exactly once. */
export function visitNodes(node: KitNode, fn: (n: KitNode) => void): void {
  fn(node);
  if (node.kind === "card") {
    if (node.header) visitNodes(node.header, fn);
    node.children.forEach((c) => visitNodes(c, fn));
  } else if (node.kind === "row") {
    node.children.forEach((c) => visitNodes(c, fn));
  }
}

/** Every distinct button `action` name in a spec (#2868) — the actions a self-wiring host must
 *  resolve so a nested button's click never no-ops. Order is first-seen; duplicates collapse. */
export function collectActions(node: KitNode): string[] {
  const out = new Set<string>();
  visitNodes(node, (n) => { if (n.kind === "button" && n.action) out.add(n.action); });
  return [...out];
}
