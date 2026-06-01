// Per-agent execution flow (#297): how a planned stream behaves at runtime —
// whether it pauses for confirmation or runs continuously, and what/when it
// pushes to GitHub. Set in the planning phase, the flow drives three launch-time
// concerns: which git/gh writes auto-approve (permissions), how the kickoff's
// autonomy + push paragraph reads, and whether the agent emits a coordination
// wake at its pause points.
//
// Pure (no React/Tauri) so it can be unit-tested and shared by the planner UI,
// the tag/fleet.json parsers, and the launch path.

/** How the agent handles underspecified decisions. */
export type FlowAutonomy = "continuous" | "checkpoint" | "confirm";
/** What and whether the agent pushes to GitHub. */
export type FlowPush = "auto-pr" | "self-merge" | "push-confirm" | "commit-only" | "none";
/** Which event fires a push attempt. */
export type FlowTrigger = "per-issue" | "per-stage" | "on-green";
/** How a "confirm"/"push-confirm" pause is enforced. */
export type FlowGate = "soft" | "hard";

export interface AgentFlow {
  /** continuous = never pause; checkpoint = pause at stage/PR boundaries; confirm = ask before non-trivial decisions. */
  autonomy: FlowAutonomy;
  /** auto-pr = commit+push+open PR on green; self-merge = run full gate, rebase onto develop, re-gate, push develop directly (no PR); push-confirm = commit+test then wait; commit-only = commit, don't push; none = no git/gh. */
  push: FlowPush;
  /** When a push fires: per owned issue, per pipeline stage, or whenever the gate is green. */
  trigger: FlowTrigger;
  /** soft = kickoff instructs the agent to pause and ask; hard = the push command isn't auto-approved so the pane prompts. */
  gate: FlowGate;
}

export const FLOW_AUTONOMY: readonly FlowAutonomy[] = ["continuous", "checkpoint", "confirm"];
export const FLOW_PUSH: readonly FlowPush[] = ["auto-pr", "self-merge", "push-confirm", "commit-only", "none"];
export const FLOW_TRIGGER: readonly FlowTrigger[] = ["per-issue", "per-stage", "on-green"];
export const FLOW_GATE: readonly FlowGate[] = ["soft", "hard"];

/** The default flow a freshly-planned stream gets (confirmed with the user). */
export const DEFAULT_FLOW: AgentFlow = {
  autonomy: "continuous",
  push: "auto-pr",
  trigger: "per-issue",
  gate: "hard",
};

/** Coerce one raw value to a member of `allowed`, falling back when absent/invalid. */
function coerce<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Build a complete, valid {@link AgentFlow} from arbitrary/partial input (a tag's
 * attributes or a `fleet.json` object). Every field falls back to {@link DEFAULT_FLOW},
 * so the result is always launch-safe. Unknown keys are ignored.
 */
export function normalizeFlow(input: Record<string, unknown> | null | undefined): AgentFlow {
  const o = input ?? {};
  return {
    autonomy: coerce(o.autonomy, FLOW_AUTONOMY, DEFAULT_FLOW.autonomy),
    push:     coerce(o.push,     FLOW_PUSH,     DEFAULT_FLOW.push),
    trigger:  coerce(o.trigger,  FLOW_TRIGGER,  DEFAULT_FLOW.trigger),
    gate:     coerce(o.gate,     FLOW_GATE,     DEFAULT_FLOW.gate),
  };
}

/**
 * Like {@link normalizeFlow} but returns `undefined` when the input names none of
 * the four flow fields — so a stream that never specified a flow stays `flow:
 * undefined` (the launch path applies {@link DEFAULT_FLOW}) instead of being
 * silently materialized. Preserves backward-compat for pre-flow plans.
 */
export function flowOrUndefined(input: Record<string, unknown> | null | undefined): AgentFlow | undefined {
  const o = input ?? {};
  const named = ["autonomy", "push", "trigger", "gate"].some(
    (k) => typeof o[k] === "string" && (o[k] as string).trim() !== "",
  );
  return named ? normalizeFlow(o) : undefined;
}

/** The effective flow for a stream, applying {@link DEFAULT_FLOW} when unset. */
export function resolveFlow(flow: AgentFlow | undefined): AgentFlow {
  return flow ?? DEFAULT_FLOW;
}
