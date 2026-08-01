// Preview-data bindings (#2940): which librarian ALGORITHM feeds which component's preview data prop —
// the studio-network payoff (a component's preview renders real algorithm-generated data instead of the
// `[]`/trivial sample). Deliberately DECOUPLED from the generated `react-ui.json` kit descriptor (no
// drift-guard / generator entanglement): a binding is a designer-authored render concern, resolved at
// preview time by `usePreviewData` (run the impl's `vizCode` in the sandbox → `vizRunToDataset` → the
// adapter → the prop value). The runtime `bsc ui` authoring verb is a fast-follow; this seeds the exemplar.
import type { VizDataset } from "@/features/algorithms";

/** An adapter maps the algorithm's normalized {@link VizDataset} to the VALUE a component's data prop
 *  expects — the ONLY per-component shape glue, kept tiny + pure + named so each is unit-tested. */
export type PreviewAdapterKind = "grid" | "graph" | "values" | "cells";

/** One binding: a component's data prop is fed by an algorithm impl, its output shaped by an adapter. */
export interface PreviewBinding {
  /** Kit id the component belongs to (e.g. `react-d3`). */
  kitId: string;
  /** Component name (matched case-insensitively against {@link ComponentRecord.name}). */
  component: string;
  /** The data prop to feed. */
  prop: string;
  /** The algorithm impl id whose `vizCode` is run to generate the data (e.g. `sort.ts`). */
  algorithm: string;
  /** How to shape the run's dataset into the prop's value. */
  adapter: PreviewAdapterKind;
}

/** The seeded bindings. The exemplar (#2940): the react-d3 **Heatmap**'s `data` prop is fed by the
 *  **insertion sort** (`sort.ts`) — its sorted `number[]` output laid into a weekly `HeatDatum[]` grid,
 *  so the preview shows a real generated matrix instead of the built-in sample. */
export const PREVIEW_BINDINGS: readonly PreviewBinding[] = [
  { kitId: "react-d3", component: "Heatmap", prop: "data", algorithm: "sort.ts", adapter: "grid" },
];

/** The binding for `comp` (kit + name match), or undefined. */
export function bindingFor(kitId: string, componentName: string): PreviewBinding | undefined {
  const name = componentName.toLowerCase();
  return PREVIEW_BINDINGS.find((b) => b.kitId === kitId && b.component.toLowerCase() === name);
}

/** A `HeatDatum` — the react-d3 Heatmap's cell shape (`data: HeatDatum[]`). */
interface HeatDatum { x: string; y: string; value: number }

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Shape a run's dataset into the component prop's value. Pure + total: an unusable dataset for the
 * requested adapter returns `null` (the caller then falls back to the component's own sample).
 */
export function adaptDataset(ds: VizDataset | undefined, adapter: PreviewAdapterKind): unknown {
  // A run with no bindable dataset (a stack/scalar program, #4162) adapts to nothing — the same `null`
  // every shape mismatch below returns, so the caller's existing empty-data path handles it unchanged.
  if (!ds) return null;
  switch (adapter) {
    case "values":
      return ds.kind === "array" ? ds.data : null;
    case "graph":
      return ds.kind === "graph" ? { nodes: ds.nodes, edges: ds.edges } : null;
    case "cells":
      // matrix → one HeatDatum per cell (row index → y, col index → x).
      return ds.kind === "matrix"
        ? ds.data.flatMap((row, y) => row.map((value, x): HeatDatum => ({ x: String(x), y: String(y), value })))
        : null;
    case "grid": {
      // array → a weekly grid: successive values fill columns (weekday) then wrap to the next row.
      if (ds.kind !== "array") return null;
      return ds.data.map((value, i): HeatDatum => ({ x: WEEK[i % WEEK.length], y: String(Math.floor(i / WEEK.length)), value }));
    }
  }
}
