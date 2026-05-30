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
  // A failure carries the stage's one-line reason into the next stage as its seed
  // (e.g. the test failure handed to the fix stage).
  const seed = ev.type === "failed" ? ev.reason : undefined;
  const result = conduct(run, ev.type === "landed" ? "success" : "failure", seed);
  return { registry: { runs: { ...reg.runs, [parsed.item]: result.run } }, result };
}

// -- Stage prompt (#220 live wiring) --------------------------------------------
// The agent-facing instruction a stage session is launched with: its role, what to do,
// the prior stage's output (seed), and -- critically -- how to report its outcome so the
// conductor advances the pipeline (emit a #199 event against its stage ref).

const STAGE_GUIDANCE: Record<string, string> = {
  implement: "Make the change for this work item within your ownership boundary, then commit. Do not merge.",
  fix: "A prior build/test run failed (see below). Fix the cause, then commit. Do not merge.",
  "build-test": "Run the build and the test suite. Report pass or fail. Do NOT edit code or merge.",
  review: "Review the change for correctness and quality. Decide approve or request-changes. Do NOT edit or merge.",
  integrate: "Merge the change and update the board. Do NOT write code.",
  spike: "Explore the problem and produce a throwaway proof-of-concept + findings. Do not merge.",
  research: "Research the problem and write up what you found. Do not edit code.",
  plan: "Turn the research into a concrete implementation plan. Do not edit code.",
};

/** Compose the startup prompt for a stage session: role, task, seed, and the exact
 *  `bsc-landed`/`bsc-failed` commands that signal the outcome to the conductor. */
export function stagePrompt(launch: StageLaunch, item: string): string {
  const ref = `contract:${stageRefName(item, launch.stage)}`;
  const guidance = STAGE_GUIDANCE[launch.stage] ?? `Carry out the "${launch.stage}" stage for this work item.`;
  const lines = [
    `You are the **${launch.stage}** stage of a pipeline for work item ${item}, running as the \`${launch.role}\` role (least privilege: github=${launch.capability.github}, git=${launch.capability.git}, code=${launch.capability.code}).`,
    "",
    guidance,
  ];
  if (launch.seed) {
    lines.push("", "Output from the prior stage:", "```", launch.seed, "```");
  }
  lines.push(
    "",
    "When you finish, signal the result so the conductor advances the pipeline:",
    `- success: run  bsc-landed '${ref}'`,
    `- failure: run  echo "<one-line reason>" | bsc-failed '${ref}'`,
  );
  return lines.join("\n");
}
