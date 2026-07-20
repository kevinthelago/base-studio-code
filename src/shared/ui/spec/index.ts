// The spec-first UI SDK (#1852 Phase 2) — public barrel. An AI emits a node tree as data;
// `validateGeneralNode` checks it against the shared primitive contract (`@data/ui/primitives.json`,
// generated from `shared/ui/manifest.ts` and also served + enforced by `bsc ui schema` / `validate`);
// `KitRenderer` renders it through the real kit primitives, wiring `binds` (host state in) and
// `actions` (host behaviour out). See `demoSpec` for a real end-to-end example.
//
// #3500 collapsed the closed `KitNode` vocabulary — the 8 hardcoded kinds (card/header/field/button/
// row/toggle/tag/text) and the hand-written renderer branch behind each — into this ONE open node
// over the whole manifest. A spec now names real components, so adding a primitive makes it
// authorable with no edit to the renderer, the validator, or the contract.

export type { GeneralNode } from "./generalNode";
export { validateGeneralNode, PRIMITIVE_NAMES, VALIDATION_COVERAGE } from "./generalNode";
export { KitRenderer } from "./KitRenderer";
export type { KitRendererProps, KitBindings } from "./KitRenderer";
export { SelfWiredKitRenderer } from "./SelfWiredKitRenderer";
export type { SelfWiredKitRendererProps } from "./SelfWiredKitRenderer";
export { visitNodes, collectActions } from "./specWalk";
export { demoSpec } from "./demoSpec";
