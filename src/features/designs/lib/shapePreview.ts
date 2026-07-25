// shapePreview (#3439) — the SHAPE tier of component preview data. A component that declares a
// `DataShape` (e.g. `shapes: ["list"]`) is fed REAL algorithm-generated data with NO per-component
// `PREVIEW_BINDINGS` row. It sits BETWEEN the curated binding and `samplePropValue`:
//
//     curated binding  →  shape-mock (here)  →  samplePropValue
//
// Only shapes whose data can be both PRODUCED (a `datasetForStructure`) and LANDED on a real data prop
// are supported — today `list` (an array prop, filled with generic objects that render across the feed /
// collection components) and `graph` (NetworkPage's `nodes`[+`edges`] arrays). Layout composites with no
// data-array prop (GraphCanvas `world:object`, MasterDetail render-props) find no target and fall through
// to `samplePropValue`, exactly as #3439's acceptance requires. `tree` is deferred to #3790 (it needs a
// new `VizDataset` kind + adapter). Pure + synchronous (the trace programs run on the main thread) and
// strictly FAIL-SOFT: any gap returns `{}` so the component's own sample shows and a preview is never
// broken.
import type { VizDataset, PreviewStructure } from "@/features/algorithms";
import { isCollectionProp } from "./componentPreview";
import type { ComponentRecord, DataShape, PropSpec } from "./model";

/** Fetches a real dataset for a structure. INJECTED (not imported) so this module holds no runtime
 *  dependency on the `@/features/algorithms` barrel — importing the barrel value here pulls its
 *  crossGraphAdapter ↔ designs libraryComposition module-init cycle into every unit test. `usePreviewData`
 *  passes the real `datasetForStructure`; tests pass the real one via the deep (barrel-free) path or a stub. */
export type DatasetForStructure = (structure: PreviewStructure) => VizDataset | undefined;

/** Shape → how to source its dataset + how to land it on the component's props. */
interface ShapeTierEntry {
  structure: PreviewStructure;
  /** Map the dataset onto the component's props → `{ propName: value }`, or `null` when the component
   *  has no prop this shape can land on (then the shape falls through). */
  fill: (ds: VizDataset, props: PropSpec[]) => Record<string, unknown> | null;
}

/** Prop names that conventionally hold the primary data collection — preferred over any other array prop
 *  so a component with an incidental array prop (e.g. `columns`) still gets its DATA prop filled. */
const DATA_PROP_NAMES = ["items", "rows", "data", "entries", "records", "list"];

/** The first array-typed prop, preferring the conventional data-prop names. */
function firstArrayProp(props: PropSpec[]): PropSpec | undefined {
  const arrays = props.filter(isCollectionProp);
  return arrays.find((p) => DATA_PROP_NAMES.includes(p.name.toLowerCase())) ?? arrays[0];
}

function arrayProp(props: PropSpec[], name: string): PropSpec | undefined {
  return props.find((p) => p.name.toLowerCase() === name && isCollectionProp(p));
}

export const SHAPE_TIER: Partial<Record<DataShape, ShapeTierEntry>> = {
  list: {
    structure: "array",
    fill: (ds, props) => {
      if (ds.kind !== "array") return null;
      const prop = firstArrayProp(props);
      if (!prop) return null; // render-prop layout (MasterDetail, CardListRow) → fall through
      // Generic, render-SAFE objects: the UNION of the fields the real list components read, so each
      // renders fully and none crashes — CollectionItem { id, title } AND ActivityItem { login, action,
      // target, repo, createdAt } (its Avatar needs a `login`). The algorithm's value rides along as
      // `value`. Fixed strings keep it deterministic (no `new Date()` → no per-render flicker).
      const items = ds.data.map((value, i) => ({
        id: `n${i}`,
        title: `Item ${i + 1}`,
        label: `Item ${i + 1}`,
        login: `user${(i % 8) + 1}`,
        action: "updated",
        target: `item ${i + 1}`,
        repo: "demo/app",
        createdAt: "2026-01-01T00:00:00.000Z",
        value,
      }));
      return { [prop.name]: items };
    },
  },
  graph: {
    structure: "graph",
    fill: (ds, props) => {
      if (ds.kind !== "graph") return null;
      const nodesProp = arrayProp(props, "nodes");
      if (!nodesProp) return null; // GraphCanvas (world:object, children) has no nodes array → fall through
      const out: Record<string, unknown> = {
        // NetworkNodeData { id, label } — label defaults to the id so it always renders.
        [nodesProp.name]: ds.nodes.map((n) => ({ id: n.id, label: n.label ?? n.id })),
      };
      const edgesProp = arrayProp(props, "edges");
      // NetworkEdgeData { from, to }.
      if (edgesProp) out[edgesProp.name] = ds.edges.map((e) => ({ from: e.from, to: e.to }));
      return out;
    },
  },
};

/** The shape-tier preview-data override for `comp` (`{ prop: JS-source literal }`), or `{}` when it
 *  declares no supported shape, its shape can't land on a real prop, or the dataset is unavailable.
 *  `getDataset` sources the real per-structure dataset (see {@link DatasetForStructure}). */
export function shapePreviewData(comp: ComponentRecord, getDataset: DatasetForStructure): Record<string, string> {
  for (const shape of comp.shapes ?? []) {
    const entry = SHAPE_TIER[shape];
    if (!entry) continue;
    const ds = getDataset(entry.structure);
    if (!ds) continue;
    const filled = entry.fill(ds, comp.props);
    if (filled && Object.keys(filled).length > 0) {
      return Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, JSON.stringify(v)]));
    }
  }
  return {};
}
