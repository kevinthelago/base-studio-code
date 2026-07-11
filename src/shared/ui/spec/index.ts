// The spec-first UI SDK (#1852 Phase 2) — public barrel. An AI emits a `KitNode` tree as data;
// `validateKitNode` checks it against the shared contract (`@data/ui/kit-nodes.json`, also enforced
// by `bsc ui`); `KitRenderer` renders it through the active kit's primitives, wiring `bind`/`action`
// to host state. See `demoSpec` for a real end-to-end example.

export type {
  KitNode, KitContract, KitNodeSpec, NodeKind,
  CardNode, HeaderNode, FieldNode, ButtonNode, RowNode, ToggleNode, TagNode, TextNode,
} from "./schema";
export { validateKitNode, NODE_CONTRACT } from "./schema";
export { KitRenderer } from "./KitRenderer";
export type { KitRendererProps, KitBindings } from "./KitRenderer";
export { SelfWiredKitRenderer } from "./SelfWiredKitRenderer";
export type { SelfWiredKitRendererProps } from "./SelfWiredKitRenderer";
export { visitNodes, collectActions } from "./specWalk";
export { demoSpec } from "./demoSpec";
