// Planner provenance gate (#1107). Scans the planner's AUTHORED artifacts (the section files it
// writes from reviewed repos/web) for injection markers, and turns the findings into a gate the
// user crosses before the plan seeds the fleet. Two modes:
//
//   - default (acknowledge-to-clear): findings are surfaced; the user reviews and acknowledges them
//     to proceed (a flag can be a false positive — kickoffs/sections legitimately contain
//     instructions — so the gate is on REVIEW, not on zero-flags).
//   - hard gate (Settings toggle `injectionHardGate`): any finding BLOCKS promotion until the
//     flagged content is removed — no acknowledge bypass.
//
// Pure; no React/Tauri. The detection lives in the shared lib/security/injectionScan.

import { scanArtifacts, type InjectionFinding } from "../../../lib/security/injectionScan";

export type { InjectionFinding };

/** Scan the planner-authored section files for injection markers. */
export function findPlanInjections(sections: Record<string, string>): InjectionFinding[] {
  return scanArtifacts(sections);
}

/** A stable, order-independent signature of a finding set. A user's "reviewed" acknowledgement is
 *  keyed by this, so adding new injected content (a new finding) invalidates the ack and re-gates. */
export function injectionSignature(findings: InjectionFinding[]): string {
  return findings.map((f) => `${f.file}:${f.line}:${f.category}`).sort().join("|");
}

export type InjectionGateMode = "clear" | "review" | "blocked";

export interface InjectionGate {
  findings: InjectionFinding[];
  /** `clear` = nothing flagged; `review` = flagged, acknowledge-to-clear available; `blocked` = the
   *  hard gate is on, so the flagged content must be removed (no acknowledgement bypass). */
  mode: InjectionGateMode;
  /** Whether plan → fleet promotion may proceed. */
  cleared: boolean;
}

/** Resolve the gate from findings + the hard-gate setting + the user's acknowledged signature. */
export function injectionGate(
  findings: InjectionFinding[],
  opts: { hardGate: boolean; ackSig?: string },
): InjectionGate {
  if (findings.length === 0) return { findings, mode: "clear", cleared: true };
  if (opts.hardGate) return { findings, mode: "blocked", cleared: false };
  return { findings, mode: "review", cleared: opts.ackSig === injectionSignature(findings) };
}
