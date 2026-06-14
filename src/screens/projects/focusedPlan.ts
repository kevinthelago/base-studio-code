// Focused planner pane (#652) — the pure model behind the one-phase-at-a-time right
// pane. It wraps the EXISTING blueprint/signal/gate logic (sectionStatus / currentSection
// / evalGate) into a navigable "phase" view: which phases are visible, each one's status
// (complete / active / locked / upcoming), the gate pill, and the advance-bar action.
// Pure + serializable so it's fully unit-testable; no React/Tauri.

import {
  enabledSections, currentSection, sectionStatus,
  type BlueprintSection,
} from "./blueprints";
import { evalGate, gateReasons, type PlanSignals } from "./stageGate";

// "complete" = done IN sequence (at/behind the current position); "ahead" = done OUT of
// sequence (gate met past the current position — "banked"); "skipped" = an OPTIONAL section
// the user has moved past without completing (#678). The rail renders each distinctly so a
// future stage finishing early / a passed-over optional stage don't read as in-order
// progress or as a not-yet-reached stage (#668).
export type PhaseStatus = "complete" | "ahead" | "active" | "skipped" | "locked" | "upcoming";

export interface Phase {
  key: string;
  name: string;
  glyph: string;
  blurb: string;
  /** The section's human gate description. */
  gate: string;
  index: number;
  total: number;
  status: PhaseStatus;
  /** Gate fill 0..1 for the in-progress fraction. */
  fraction: number;
  /** An optional stage — shown but never required (#676). */
  optional?: boolean;
  /** The still-unmet gate requirements (label + progress detail) — drives the "why is this
   *  blocked" feedback on the gate pill (#805). Empty once the gate passes. */
  unmet?: { label: string; detail?: string }[];
}

/**
 * The visible phase list: enabled, non-N/A sections in declared order, each tagged with
 * its status — complete (gate passed), active (the current reached phase), locked (a
 * dependency is unmet), or upcoming (reachable but not yet current).
 */
export function phasesFrom(sections: BlueprintSection[], signals: PlanSignals): Phase[] {
  const current = currentSection(sections, signals);
  const visible = enabledSections(sections)
    .map((s) => ({ s, st: sectionStatus(s, sections, signals) }))
    .filter(({ st }) => st.status !== "na");
  // The current position among visible phases; everything complete PAST it is "ahead".
  const activeIdx = current ? visible.findIndex(({ s }) => s.key === current.key) : visible.length;
  return visible.map(({ s, st }, i) => {
    let status: PhaseStatus;
    if (st.status === "complete") status = i > activeIdx ? "ahead" : "complete";
    else if (st.status === "locked") status = "locked";
    // an optional section the current position has already moved past, left unfinished
    else if (s.optional && i < activeIdx) status = "skipped";
    else status = current && s.key === current.key ? "active" : "upcoming";
    const unmet = gateReasons(s.gateRule, signals)
      .filter((r) => !r.pass)
      .map(({ label, detail }) => ({ label, detail }));
    return {
      key: s.key, name: s.name, glyph: s.glyph, blurb: s.blurb, gate: s.gate,
      index: i, total: visible.length, status, fraction: st.fraction, optional: s.optional, unmet,
    };
  });
}

export type ConnectorKind = "solid" | "partial" | "dashed" | "dim";

/** The rail connector AFTER node `i` (#668): solid traces the walked in-sequence path,
 *  partial leaves the current node, dashed reaches a banked-ahead node, dim otherwise. */
export function connectorKind(phases: Phase[], i: number): ConnectorKind {
  const role = phases[i]?.status;
  const next = phases[i + 1]?.status;
  // A banked-ahead node (done out of sequence) is reached by a dashed connector.
  if (role === "ahead" || next === "ahead") return "dashed";
  // The walked path is green UP TO the current node: every connector positioned BEFORE the
  // active node is solid — including the one leaving a skipped/optional section — so the
  // green leads INTO the current node, never out of it. Beyond the current node: dim (#668).
  const activeIdx = phases.findIndex((p) => p.status === "active");
  const frontier = activeIdx >= 0 ? activeIdx : phases.length;
  return i < frontier ? "solid" : "dim";
}

/** Index of the active phase (else the last) — what the selection auto-follows. */
export function activeIndex(phases: Phase[]): number {
  const a = phases.findIndex((p) => p.status === "active");
  return a >= 0 ? a : Math.max(0, phases.length - 1);
}

/** Clamp an index into [0, count-1] (0 when empty) — guards against a shrunk phase list
 *  after a blueprint switch / clear. */
export function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, i), count - 1);
}

export type GatePill = "pass" | "blocked" | "wait";

/** Gate pill for a phase: pass (gate satisfied), blocked (a gate-pipeline is blocking it),
 *  or wait (still in progress). */
export function gatePill(phase: Phase, blocked: boolean): GatePill {
  if (blocked) return "blocked";
  return phase.status === "complete" || phase.status === "ahead" ? "pass" : "wait";
}

export type FooterKind = "back-to-current" | "jump-to-current" | "approve-continue" | "publish";

/**
 * The advance-bar's primary action, by where the selection sits relative to the active
 * phase. Browsing a future (locked) phase → back to current; a past phase → jump to
 * current; on the active phase → approve & continue (enabled when its gate is ready), or
 * publish when the whole plan is complete.
 */
export function footerAction(
  selectedIdx: number, activeIdx: number, planComplete: boolean, currentGateReady: boolean,
): { kind: FooterKind; enabled: boolean } {
  if (selectedIdx > activeIdx) return { kind: "back-to-current", enabled: true };
  if (selectedIdx < activeIdx) return { kind: "jump-to-current", enabled: true };
  if (planComplete) return { kind: "publish", enabled: true };
  return { kind: "approve-continue", enabled: currentGateReady };
}

/** Whether the active phase's gate is satisfied — enables "approve & continue". */
export function currentGateReady(sections: BlueprintSection[], signals: PlanSignals): boolean {
  const cur = currentSection(sections, signals);
  return !!cur && evalGate(cur.gateRule, signals).done;
}
