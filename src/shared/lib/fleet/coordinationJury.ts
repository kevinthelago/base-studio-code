// -- Verification jury (#394) ----------------------------------------------------
// The jury is the watchdog's BRAIN, not a new gate. Under self-merge a worker writes
// the code AND its tests and merges on a green gate -- which proves internal
// consistency, not correctness. The jury reviews POST-merge and async: each juror
// judges the landing from a DIFFERENT anchor than the worker used (acceptance
// criteria / lens / subsystem slice), so their errors are uncorrelated; a reject
// drives the SAME revert+ping reflex the watchdog already runs (#382), with the
// juror's reason as a fix-forward instruction. Pure + testable; the foreman/strategy
// wiring lands on top.
import type {
  CoordEvent,
  JurorVerdict,
  AggregationRule,
  JuryStrictness,
  JuryAggregate,
  JuryAction,
  TriageDecision,
  TriageConfig,
  LandingSignals,
} from "./coordination.types";
import { parseRef } from "./coordinationState";

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = { maxDiffLines: 150, minCoverageDelta: -1 };

/**
 * Risk-triage a landing: a cheap signal decides whether the full jury convenes or the
 * change takes the fast-path (no panel). Any high-risk signal — a shared/contract file,
 * a security path, a repeat-offender region, a large diff, or a coverage drop — forces a
 * panel; otherwise fast-path. Like risk-based testing: spend the panel where it pays.
 */
export function triageLanding(sig: LandingSignals, cfg: TriageConfig = DEFAULT_TRIAGE_CONFIG): TriageDecision {
  if (sig.touchesSharedOrContract || sig.securitySensitive || sig.revertedBefore) return "panel";
  if ((sig.diffLines ?? 0) >= cfg.maxDiffLines) return "panel";
  if (sig.coverageDelta !== undefined && sig.coverageDelta <= cfg.minCoverageDelta) return "panel";
  return "fast-path";
}

/**
 * Aggregate a panel's verdicts into one outcome, robust to noisy jurors. Under the
 * default `pass-unless-concrete` strictness a reject only counts if it carries a reason,
 * so a juror that rejects on vague doubt can't sink a landing. The `quorum` rule first
 * restricts to jurors whose slice the change touches (`relevant !== false`), so an
 * off-slice juror's noise is ignored entirely.
 */
export function aggregateVerdicts(
  verdicts: JurorVerdict[],
  rule: AggregationRule,
  strictness: JuryStrictness = "pass-unless-concrete",
): JuryAggregate {
  const counts = (v: JurorVerdict) =>
    v.verdict === "reject" && (strictness === "reject-on-doubt" || !!v.reason?.trim());
  const panel = rule === "quorum" ? verdicts.filter((v) => v.relevant !== false) : verdicts;
  const rejects = panel.filter(counts);
  const reject =
    rule === "veto"
      ? rejects.length > 0
      : rejects.length * 2 > panel.length; // strict majority (of the relevant panel for quorum)
  return {
    verdict: reject ? "reject" : "pass",
    rejecters: reject ? rejects.map((v) => v.juror) : [],
    reason: reject ? rejects.find((v) => v.reason?.trim())?.reason : undefined,
  };
}

/** Fold verdict events into per-landing tallies (keyed by the verdict `target`). A juror's
 *  latest verdict on a target replaces an earlier one. Non-verdict events are ignored. */
export function tallyVerdicts(events: CoordEvent[]): Map<string, JurorVerdict[]> {
  const byTarget = new Map<string, Map<string, JurorVerdict>>();
  for (const e of events) {
    if (e.type !== "verdict") continue;
    const jurors = byTarget.get(e.target) ?? new Map<string, JurorVerdict>();
    jurors.set(e.juror, { juror: e.juror, verdict: e.verdict, reason: e.reason, relevant: e.relevant });
    byTarget.set(e.target, jurors);
  }
  const out = new Map<string, JurorVerdict[]>();
  for (const [target, jurors] of byTarget) out.set(target, [...jurors.values()]);
  return out;
}

/** Compose the owner-facing ping for a rejected landing — the fix-forward instruction. */
export function juryPingMessage(target: string, reason: string | undefined): string {
  return `The verification jury rejected ${target}: ${reason?.trim() || "see the jurors' notes"}. It was reverted — fix forward and re-land.`;
}

/**
 * Decide the foreman's action for a landing from its panel: aggregate the verdicts and,
 * on reject, produce a revert targeting the landing ref plus an owner ping carrying the
 * reason. On pass, no action. This is the reject→revert+ping wiring in pure form — the
 * caller feeds `ref` into {@link fail} and delivers `ping` via the existing notification
 * path.
 */
export function planJuryAction(
  target: string,
  verdicts: JurorVerdict[],
  rule: AggregationRule,
  strictness: JuryStrictness = "pass-unless-concrete",
): JuryAction {
  const agg = aggregateVerdicts(verdicts, rule, strictness);
  if (agg.verdict === "pass") return { target, action: "pass", ref: parseRef(target) };
  return {
    target,
    action: "revert",
    ref: parseRef(target),
    reason: agg.reason,
    ping: juryPingMessage(target, agg.reason),
  };
}
