// Declarative, serializable completion gates for planning sections (#…).
//
// A section's "done-ness" used to be executable code hung off the PLAN_STAGES
// registry (`gate: (s) => …`). That made a section impossible to author, share, or
// distribute as data — you couldn't ship one over the WAN without shipping code.
//
// A StageGate is a pure DATA predicate over a flat bag of named SIGNALS the app
// publishes (repoCount, issueCount, coreConfirmed, …). The app evaluates the gate;
// the section — built-in OR cloud-distributed — only ever carries JSON. New sections
// compose the existing signal vocabulary but cannot invent signals or run code, which
// is the safety boundary that makes distribution viable.
//
// This module is pure (no React/Tauri) and has no dependency on the stage registry,
// so it can be reused by the desktop, the relay, and any future authoring tool.

/** The flat, serializable signal bag the app computes from live plan state.
 *  Missing keys read as 0 (numeric) / false (boolean) when evaluated. */
export type PlanSignals = Record<string, number | boolean>;

/** Comparison operators a numeric requirement may use. Default is ">=". */
export type GateOp = ">=" | ">" | "<=" | "<" | "==" | "!=";

/** One requirement of a gate: a single signal compared against a target. */
export interface Requirement {
  /** Signal this requirement reads. */
  signal: string;
  /** Pass threshold. Boolean ⇒ identity match; number ⇒ compared with {@link op}.
   *  Defaults to `true` (a presence/acknowledgement flag). */
  target?: number | boolean;
  /** Numeric comparison operator (ignored for boolean targets). Default ">=". */
  op?: GateOp;
  /** Denominator signal for an "X of Y" ratio. When set, progress = signal / of
   *  and the requirement passes only when `of > 0` and signal meets `of`. */
  of?: string;
  /** Weight of this requirement in the bar-fill fraction. Default 1.
   *  Use 0 for a must-pass flag that should not move the progress fill. */
  weight?: number;
  /** Optional per-requirement human reason (what's left), for richer feedback. */
  label?: string;
}

/** A completion gate: every requirement must pass (logical AND). An empty/absent
 *  gate is vacuously satisfied — the safe default for an informational section. */
export interface StageGate {
  require: Requirement[];
}

function asNumber(v: number | boolean | undefined): number {
  return typeof v === "number" ? v : v ? 1 : 0;
}
function asBool(v: number | boolean | undefined): boolean {
  return typeof v === "boolean" ? v : !!v;
}
function compare(a: number, b: number, op: GateOp): boolean {
  switch (op) {
    case ">":  return a > b;
    case "<":  return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    case ">=":
    default:   return a >= b;
  }
}

/** Evaluate a single requirement → did it pass, and its 0..1 progress. */
export function evalRequirement(r: Requirement, signals: PlanSignals): { pass: boolean; progress: number } {
  // Ratio ("X of Y") takes precedence over the target default — `of` makes it numeric
  // even when no explicit numeric target is given.
  if (r.of) {
    const v = asNumber(signals[r.signal]);
    const denom = asNumber(signals[r.of]);
    const progress = denom > 0 ? Math.min(v / denom, 1) : 0;
    const pass = denom > 0 && compare(v, denom, r.op ?? ">=");
    return { pass, progress };
  }
  const target = r.target ?? true;
  if (typeof target === "boolean") {
    const v = asBool(signals[r.signal]);
    const pass = r.op === "!=" ? v !== target : v === target;
    return { pass, progress: pass ? 1 : 0 };
  }
  const v = asNumber(signals[r.signal]);
  const pass = compare(v, target, r.op ?? ">=");
  const progress = pass ? 1 : target > 0 ? Math.min(v / target, 1) : 0;
  return { pass, progress };
}

/**
 * Evaluate a gate against the signal bag. `done` is the AND of every requirement;
 * `fraction` is the weight-averaged progress (requirements with weight 0 are must-pass
 * but contribute no fill). An empty gate is done with full fraction.
 */
export function evalGate(gate: StageGate | undefined, signals: PlanSignals): { done: boolean; fraction: number } {
  const reqs = gate?.require ?? [];
  if (reqs.length === 0) return { done: true, fraction: 1 };
  let done = true;
  let weightSum = 0;
  let fillSum = 0;
  for (const r of reqs) {
    const { pass, progress } = evalRequirement(r, signals);
    if (!pass) done = false;
    const w = r.weight ?? 1;
    weightSum += w;
    fillSum += w * progress;
  }
  const fraction = weightSum > 0 ? fillSum / weightSum : done ? 1 : 0;
  return { done, fraction };
}

/** Whether a section applies at all (e.g. UI only when the project needs a UI).
 *  An absent rule means the section always applies. */
export function gateApplies(rule: Requirement | undefined, signals: PlanSignals): boolean {
  return rule ? evalRequirement(rule, signals).pass : true;
}
