// The Fleet page's STRUCTURE, as data (#3504) — slice 3d of the ui-as-data keystone (#3484), and the
// renderer-honesty check the whole epic was building toward: a real, live, production page whose
// layout comes from a validated node tree rather than JSX.
//
// BE PRECISE ABOUT WHAT IS DATA HERE. The page's *skeleton* is: the header row, the six-tile stat
// grid, the `1.6fr 1fr` split, and which panel sits in which column. That is what a designer or an
// agent would actually want to rearrange, and it is now editable without touching code.
//
// What is NOT data, deliberately:
//   - the `Fleet` host — it owns `useFleetLive`, the GitHub query, the refresh nonce, and the
//     `selected` worker routing;
//   - the nine panels (`WorkerBoard`, `FleetHealth`, `Throughput`, …) — they own hooks and app state,
//     so they arrive through `Slot`s. They are app code, not kit; re-expressing them as primitives
//     would be a lie about what the vocabulary can do.
//
// The seam is: this file says WHERE, the host says WHAT (`slots`) and WITH WHICH VALUES (`binds`).
// The six stat tiles bind their numbers individually rather than being one opaque host slot — a stat
// grid delivered as a single slot would render identically and prove nothing.
import { validateGeneralNode, type GeneralNode } from "@/shared/ui/spec";

/** One KPI tile. `v`/`tone`/`loading` come from host state; the label and caption are fixed prose. */
function statCard(k: string, sub: string, valueKey: string, opts: { tone?: string; toneKey?: string; loadingKey?: string } = {}): GeneralNode {
  const binds: Record<string, string> = { v: valueKey };
  if (opts.toneKey) binds.tone = opts.toneKey;
  if (opts.loadingKey) binds.loading = opts.loadingKey;
  return {
    type: "StatCard",
    props: { k, sub, ...(opts.tone ? { tone: opts.tone } : {}) },
    binds,
  };
}

/** A panel column of the main split. `minWidth: 0` is LOAD-BEARING — without it a grid child refuses
 *  to shrink below its content and the wide panels overflow the column. */
function column(slots: string[]): GeneralNode {
  return {
    type: "Stack",
    props: { gap: 14, style: { minWidth: 0 } },
    children: slots.map((name) => ({ type: "Slot", props: { name } }) as GeneralNode),
  };
}

/** The Fleet page's node id in the components store (the harvested `FleetPage`, #3569) — the host reads
 *  that node's `spec` and renders it, so a Design Studio edit reflects on the real page. This const below
 *  is the SEED/FALLBACK, used until the store node carries a valid `spec`. */
export const FLEET_PAGE_ID = "fleetpage";

export const FLEET_PAGE_SPEC: GeneralNode = {
  type: "Box",
  props: {
    as: "section",
    className: "an-page",
    children: {
      type: "Box",
      props: { className: "an-wrap" },
      children: [
        // ── Header: title + live summary line + the two actions ──────────────────────────────────
        {
          type: "Row",
          props: { align: "start", gap: 14, style: { marginBottom: 14 } },
          children: [
            {
              type: "Box",
              props: { style: { flex: 1 } },
              children: [
                {
                  type: "Text",
                  props: { as: "h2", mono: true, size: 20, weight: 600, style: { margin: 0 } },
                  children: "Fleet",
                },
                // The summary sentence is COMPUTED prose (worker counts, or the no-fleet line), so the
                // host binds the finished string. Assembling it here would mean the spec doing string
                // logic, which is code wearing a data costume.
                {
                  type: "Text",
                  props: { as: "div", size: 12, tone: "muted", style: { marginTop: 4 } },
                  binds: { children: "summary" },
                },
              ],
            },
            {
              type: "Button",
              props: { variant: "ghost" },
              binds: { children: "refreshLabel", disabled: "loading" },
              actions: { onClick: "refresh" },
            },
            {
              type: "Button",
              props: { title: "Launch the fleet from this project's plan" },
              children: "launch worker",
              actions: { onClick: "launchWorker" },
            },
          ],
        },

        // ── The six-tile KPI grid ────────────────────────────────────────────────────────────────
        // `className="statgrid"` carries the tile styling from tokens.css; the inline template sets
        // the column count. Both are load-bearing — Box is passthrough, so they forward as written.
        {
          type: "Box",
          props: { className: "statgrid", style: { gridTemplateColumns: "repeat(6, 1fr)" } },
          children: [
            statCard("active workers", "running now", "activeOfTotal", { tone: "accent" }),
            statCard("need attention", "blocked · asking · waiting", "needAttention", { toneKey: "attentionTone" }),
            statCard("idle", "at rest", "idle", { tone: "fg" }),
            statCard("landed today", "issues closed", "landedToday", { tone: "success", loadingKey: "loading" }),
            statCard("PRs merged · 7d", "across the fleet's repos", "prsMergedWeek", { tone: "info", loadingKey: "loading" }),
            statCard("time-to-land", "open → merge median", "avgLand", { tone: "fg", loadingKey: "loading" }),
          ],
        },

        // ── The main split: wide column of boards/charts, narrow column of status panels ─────────
        {
          type: "Grid",
          props: { cols: "1.6fr 1fr", gap: 14 },
          children: [
            column(["workerBoard", "fleetHealth", "throughput", "timeToLand"]),
            column(["fleetStatus", "costEnergy", "fleetLessons", "mergeQueue"]),
          ],
        },
      ],
    },
  },
};

/** Resolve the Fleet page's skeleton (#3569): the components-store node's `spec` when it is present AND
 *  valid, else the packaged {@link FLEET_PAGE_SPEC} seed. Validating here means a malformed store edit
 *  falls back to a working page instead of crashing the renderer. Pure — the host wraps it in `useMemo`. */
export function resolveFleetSpec(storeSpec: GeneralNode | undefined): GeneralNode {
  return storeSpec && validateGeneralNode(storeSpec).length === 0 ? storeSpec : FLEET_PAGE_SPEC;
}
