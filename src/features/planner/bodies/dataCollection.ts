// Shared model + loader for the data-COLLECTION focused panes (Targets, Source
// legitimacy, …). These stages have no dedicated backend — the planner declares
// them as JSON section files in the project hub (e.g. `collectTargets.json`,
// `sourceLicensing.json`). The panes read those files back via `read_plan_sections`
// (which returns every .md/.json section keyed by file stem) and render them.
//
// Pure types + a tolerant parser. The React fetch hook (`useStageJson`) lives in
// `useStageJson.ts` so this module stays React-free. Mirrors the contract the design
// prototype's data.jsx uses (collection/data.jsx).

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

/** `collectTargets.json` — declared sources + the bound Data Model. */
export interface CollectTargets {
  sources: CollectSource[];
  dataModel?: { name: string; entities: { name: string; fields: string[] }[] } | null;
}

export type ClearStatus = "cleared" | "needs review" | "blocked";

/** Per-source legitimacy verdict (ToS / robots / license clearance). */
export interface SourceClearance {
  status: ClearStatus;
  reason?: string;
  robots?: { delay?: string; rules: { path: string; allow: boolean }[] } | null;
  terms?: { kind?: string; text?: string; attribution?: string | null; license?: string | null } | null;
}

/** `sourceLicensing.json` — the clearance verdicts that gate acquisition. */
export interface Licensing {
  sources: CollectSource[];
  /** Keyed by source id. */
  clearance: Record<string, SourceClearance>;
  intendedUse?: string;
}

/** One source's acquisition config + capture state (`dataAcquire.json`). Scrape and
 *  fetch fields are both optional; `mode` decides which the pane renders. */
export interface AcquireSource extends CollectSource {
  // scrape
  crawl?: { start?: string[]; depth?: number; include?: string; exclude?: string };
  rate?: { rps?: string; concurrency?: number; delay?: string };
  options?: { jsRender?: boolean };
  // fetch
  endpoint?: string;
  auth?: string;
  paging?: { kind?: string; pageSize?: number };
  format?: string;
  schedule?: string;
  // capture state
  status?: "ready" | "running" | "not run";
  estimate?: string;
  captured?: string;
  run?: { note?: string; done?: number; total?: number; errors?: number; rate?: string };
}
export interface AcquirePlan { sources: AcquireSource[] }

export interface ExtractRule { sel: string; field: string; entity: string; ref?: string; ok?: boolean }
/** One source's extraction rules (`dataExtract.json`). */
export interface ExtractSource extends CollectSource {
  kind?: "HTML" | "JSON";
  artifact?: string;
  rules: ExtractRule[];
}
export interface ExtractPlan {
  sources: ExtractSource[];
  gaps?: { unmappedModel?: { field: string; why?: string }[]; unmappedSource?: { sel: string; why?: string }[] };
  sample?: { cols: string[]; rows: Record<string, string>[] };
  coverage?: { parsed?: number; total?: number; pct?: number; gaps?: { field: string; why?: string }[] };
}

// ── migration / shared back-half (Mapping · Cleaning · Load) ──────────────────

export interface FieldMapping { from: string; to: string; auto?: boolean; note?: string }
/** `dataMap.json` — source field → Data Model field, plus the dropped/unmapped gaps. */
export interface MappingPlan {
  mapped: FieldMapping[];
  droppedSource?: { field: string; why?: string }[];
  unmappedModel?: { field: string; why?: string }[];
}

export interface CleanRule { field: string; rule: string; kind?: "coerce" | "standardize" | "validate"; note?: string }
/** `dataClean.json` — the quality bar + per-field cleaning rules + quarantine policy. */
export interface CleaningPlan {
  /** Confidence threshold (%) a row must clear to enter the Data Model. */
  qualityBar?: number;
  rules: CleanRule[];
  /** Validation pass rate against the bar (%). */
  validationPct?: number;
  quarantine?: { count?: number; policy?: string };
}

export interface LoadEntity {
  entity: string;
  rows?: string;
  nulls?: number;
  valid?: number;
  src?: string[];
  /** Multi-source merge summary, e.g. "11,902 matched · 529 SQL-only". */
  merged?: string;
  conflict?: string;
  note?: string;
}
/** `dataLoad.json` — the director's load + reconcile plan, with lineage & conflicts. */
export interface LoadPlan {
  total?: string;
  entities?: number;
  lineage?: number;
  validation?: number;
  conflicts?: number;
  /** Source precedence for conflict resolution (highest first). */
  precedence?: string[];
  per: LoadEntity[];
  artifacts?: { name: string; detail?: string; glyph?: string }[];
  issues?: { t: string; tag?: string }[];
}

/** Tolerant JSON parse — a malformed / absent section yields null rather than throwing. */
export function parseStageJson<T>(raw: string | undefined): T | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** The `useStageJson` hook's result (also its return type — kept here as a pure type). */
export interface StageJson<T> { data: T | null; loading: boolean; error: string | null }

/** "2 sources (1 scrape · 1 fetch)" — the source-count summary used in pane headers. */
export function modeSummary(sources: CollectSource[]): string {
  const scrape = sources.filter((s) => s.mode === "scrape").length;
  const fetch = sources.filter((s) => s.mode === "fetch").length;
  return `${sources.length} source${sources.length !== 1 ? "s" : ""} (${scrape} scrape · ${fetch} fetch)`;
}

/** Mode chip hue (matches the design: scrape=230, fetch=175). */
export function modeHue(mode: CollectMode): number {
  return mode === "scrape" ? 230 : 175;
}
