// Pure node-tree helpers (#2868) — depth-first traversal + derived collections over a spec tree.
// No React; the interaction-defaults host (SelfWiredKitRenderer) and future behavior slices read from
// here.
//
// Generalised in #3500. The old walk descended two hardcoded kinds (`card`'s header + children, and
// `row`'s children) and treated everything else as a leaf — so a node nested in ANY other slot was
// invisible to it. The general vocabulary has no fixed set of container types, so the walk now
// descends STRUCTURALLY: any prop value that is (or contains) a node is followed, as is the
// node-level `children` sugar. A spec that renders is therefore a spec that walks — the two can no
// longer disagree about where the children are.

import { UI_KIT } from "@/shared/ui/manifest";
import type { GeneralNode } from "./generalNode";

/** Primitive name → the set of its props the manifest declares as handlers. */
const FUNCTION_PROPS = new Map(
  UI_KIT.map((p) => [
    p.name as string,
    new Set(p.props.filter((x) => x.type === "function").map((x) => x.name)),
  ]),
);

/** Is this a node? Structural, matching what the renderer will actually descend into. */
function isNode(v: unknown): v is GeneralNode {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    typeof (v as { type?: unknown }).type === "string"
  );
}

/** Follow a slot value: a node, a list of them, or plain text (a leaf). */
function visitSlot(value: unknown, fn: (n: GeneralNode) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) visitSlot(v, fn);
    return;
  }
  if (isNode(value)) visitNodes(value, fn);
}

/** Visit every node in a tree depth-first (self, then every node found in its props and children).
 *  Pure — the visitor sees each node exactly once. */
export function visitNodes(node: GeneralNode, fn: (n: GeneralNode) => void): void {
  fn(node);
  for (const value of Object.values(node.props ?? {})) visitSlot(value, fn);
  if (node.children !== undefined) visitSlot(node.children, fn);
}

/** Every distinct action name in a spec (#2868) — the actions a self-wiring host must resolve so a
 *  nested control's click never no-ops. Order is first-seen; duplicates collapse.
 *
 *  BOTH routes count, because the renderer honours both: the node-level `actions` map, and a
 *  `function`-typed prop whose value is an action name. A host that resolved only one of them would
 *  leave the other half of its own specs dead. */
export function collectActions(node: GeneralNode): string[] {
  const out = new Set<string>();
  visitNodes(node, (n) => {
    for (const name of Object.values(n.actions ?? {})) {
      if (typeof name === "string" && name) out.add(name);
    }
    const handlers = FUNCTION_PROPS.get(n.type);
    if (!handlers) return;
    for (const [prop, value] of Object.entries(n.props ?? {})) {
      if (handlers.has(prop) && typeof value === "string" && value) out.add(value);
    }
  });
  return [...out];
}
