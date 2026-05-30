// Pipeline event driver (#220): bridges the #199 coordination events to the conductor.
// A stage session reports its outcome by emitting a #199 event against its stage ref --
// `bsc-landed 'contract:pipe:<item>::<stage>'` on success, `bsc-failed …` on failure --
// and this maps that event to a `conduct(outcome)` call on the matching run. Pure (no
// store/PTY): it owns the run registry + the ref encoding; the store/PTY layer feeds it
// events and executes the returned StageLaunch. This is the last piece of #220's logic;
// the live wiring (launch a StageLaunch as a role-scoped pane, persist the registry, the
// lane view) sits on top.
import type { Pipeline } from "./pipeline";
import { type PipelineRun, type ConductResult, type StageLaunch, startRun, conduct } from "./conductor";
import type { CoordEvent } from "./coordination";

/** The `contract:` ref name a stage reports against. `::` separates item from stage so an
 *  item ref containing `:` (e.g. `#42`) round-trips. */
const PREFIX = "pipe:";
const SEP = "::";

export function stageRefName(item: string, stage: string): string {
  return `${PREFIX}${item}${SEP}${stage}`;
}

export function parseStageRefName(name: string): { item: string; stage: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const i = rest.lastIndexOf(SEP);
  if (i < 0) return null;
  const item = rest.slice(0, i);
  const stage = rest.slice(i + SEP.length);
  return item && stage ? { item, stage } : null;
}

/** In-flight pipeline runs, keyed by item. */
export interface PipelineRegistry {
  runs: Record<string, PipelineRun>;
}

export function emptyRegistry(): PipelineRegistry {
  return { runs: {} };
}

/** Start a pipeline for `item`: register the run and return its first stage launch. */
export function startPipeline(
  reg: PipelineRegistry,
  pipeline: Pipeline,
  item: string,
): { registry: PipelineRegistry; launch: StageLaunch } {
  const { run, launch } = startRun(pipeline, item);
  return { registry: { runs: { ...reg.runs, [item]: run } }, launch };
}

/**
 * Apply a #199 coord event to the registry. A `landed`/`failed` event whose ref is a
 * stage ref for an active run AT that stage advances the run (landed→success,
 * failed→failure); everything else is ignored (idempotent / irrelevant). Returns the new
 * registry and, when an advance happened, the `ConductResult` (launch/done/escalated).
 */
export function driveOnEvent(
  reg: PipelineRegistry,
  ev: CoordEvent,
): { registry: PipelineRegistry; result?: ConductResult } {
  if (ev.type !== "landed" && ev.type !== "failed") return { registry: reg };
  if (ev.ref.kind !== "contract") return { registry: reg };
  const parsed = parseStageRefName(ev.ref.name);
  if (!parsed) return { registry: reg };
  const run = reg.runs[parsed.item];
  if (!run || run.state.status !== "active" || run.state.stage !== parsed.stage) {
    return { registry: reg };
  }
  const result = conduct(run, ev.type === "landed" ? "success" : "failure");
  return { registry: { runs: { ...reg.runs, [parsed.item]: result.run } }, result };
}
