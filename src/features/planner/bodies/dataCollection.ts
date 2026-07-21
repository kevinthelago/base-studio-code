// Source-mode atoms for the planner focused-pane bodies — the `scrape` vs `fetch` vocabulary
// and the declared-source shape that `bodyPrimitives.tsx` renders (ModeChip / SourceHead).
//
// Pure types + one helper; React-free by design (the primitives that consume them are the
// React half).
//
// History: this module used to also carry the JSON contracts for a data-COLLECTION pane
// system (Targets · Licensing · Acquire · Extract · Map · Clean · Load) plus a
// `parseStageJson` loader, all keyed to a `useStageJson.ts` hook that was never written.
// None of it ever had a consumer; removed in #3244. If those panes get built, the contracts
// should be re-derived from the panes that actually need them rather than restored wholesale.

export type CollectMode = "scrape" | "fetch";

/** One declared external source (a site to scrape or an API/dataset to fetch). */
export interface CollectSource {
  id: string;
  mode: CollectMode;
  label: string;
  /** URL / endpoint / dataset identifier. */
  loc?: string;
  /** Free-text kind ("website", "REST API", "CSV dataset", …). */
  type?: string;
  /** Data Model entity names this source is expected to populate. */
  feeds?: string[];
  /** Crawl/fetch bounds — keeps acquisition bounded. */
  scope?: { start?: string; pattern?: string; bound?: string };
}

/** Mode chip hue (matches the design: scrape=230, fetch=175). */
export function modeHue(mode: CollectMode): number {
  return mode === "scrape" ? 230 : 175;
}
