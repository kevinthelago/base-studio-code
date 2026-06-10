// Focused planner pane (#652) — the pure model behind the one-phase-at-a-time right
// pane. It wraps the EXISTING blueprint/signal/gate logic (sectionStatus / currentSection
// / evalGate) into a navigable "phase" view: which phases are visible, each one's status
// (complete / active / locked / upcoming), the gate pill, and the advance-bar action.
// Pure + serializable so it's fully unit-testable; no React/Tauri.

import {
  enabledSections, currentSection, sectionStatus,
  type BlueprintSection,
} from "./blueprints";
import { evalGate, type PlanSignals } from "./stageGate";

// "complete" = done IN sequence (at/behind the current position); "ahead" = done OUT of
// sequence (gate met past the current position — "banked"). The rail renders them
// differently so a future stage finishing early doesn't read as in-order progress (#668).
export type PhaseStatus = "complete" | "ahead" | "active" | "locked" | "upcoming";

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
    else status = current && s.key === current.key ? "active" : "upcoming";
    return {
      key: s.key, name: s.name, glyph: s.glyph, blurb: s.blurb, gate: s.gate,
      index: i, total: visible.length, status, fraction: st.fraction, optional: s.optional,
    };
  });
}

export type ConnectorKind = "solid" | "partial" | "dashed" | "dim";

/** The rail connector AFTER node `i` (#668): solid traces the walked in-sequence path,
 *  partial leaves the current node, dashed reaches a banked-ahead node, dim otherwise. */
export function connectorKind(phases: Phase[], i: number): ConnectorKind {
  const role = phases[i]?.status;
  const next = phases[i + 1]?.status;
  if (role === "complete") return "solid";
  if (role === "active") return "partial";
  if (role === "ahead" || next === "ahead") return "dashed";
  return "dim";
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
