// Focused planner pane (#652) — the pure model behind the one-phase-at-a-time right
// pane. It wraps the EXISTING blueprint/signal/gate logic (sectionStatus / currentSection
// / evalGate) into a navigable "phase" view: which phases are visible, each one's status
// (complete / active / locked / upcoming), the gate pill, and the advance-bar action.
// Pure + serializable so it's fully unit-testable; no React/Tauri.

import {
  enabledSections, currentSection, sectionStatus, sectionSkipped,
  type BlueprintSection,
} from "./blueprints";
import { evalGate, gateReasons, type PlanSignals } from "./stageGate";

// "complete" = done IN sequence (at/behind the current position); "ahead" = done OUT of
// sequence (gate met past the current position — "banked"); "skipped" = an OPTIONAL section
// the USER deliberately skipped (#921 — the flow now STOPS on every optional stage; the only way
// past one without completing it is a user skip). The rail renders each distinctly so a future
// stage finishing early / a deliberately skipped stage don't read as in-order progress or as a
// not-yet-reached stage (#668).
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
  /** The Repos stage folds Deploy in as a "ship" substep (#1383) — drives the combined body. */
  ship?: boolean;
  /** The Structure stage folds Permissions in as a "fleet" substep → the "Streams" stage — drives
   *  the combined body (graph + coordination + permissions). */
  fleet?: boolean;
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
    // A deliberately user-skipped optional stage reads as "skipped", not "complete" — even though
    // it counts as resolved for the frontier/gate (`sectionDone`). Check this first (#921).
    if (sectionSkipped(s, signals)) status = "skipped";
    else if (st.status === "complete") status = i > activeIdx ? "ahead" : "complete";
    else if (st.status === "locked") status = "locked";
    else status = current && s.key === current.key ? "active" : "upcoming";
    const unmet = gateReasons(s.gateRule, signals)
      .filter((r) => !r.pass)
      .map(({ label, detail }) => ({ label, detail }));
    return {
      key: s.key, name: s.name, glyph: s.glyph, blurb: s.blurb, gate: s.gate,
      index: i, total: visible.length, status, fraction: st.fraction, optional: s.optional, unmet,
      // #1383: the Repos stage folds Deploy in as a "ship" substep when a blueprint opts in — the
      // combined body renders the deploy block only then.
      ship: s.substeps?.some((ss) => ss.key === "ship"),
      fleet: s.substeps?.some((ss) => ss.key === "fleet"),
    };
  });
}

/**
 * The blueprint section for a phase, resolved BY KEY (#815). `phases` is a FILTERED subset of the
 * raw section list (disabled / not-applicable sections like `ui` are dropped by {@link phasesFrom}),
 * so indexing the raw sections with a phase index lands on the wrong section once any earlier one is
 * dropped. The conductor uses this to inject the *active phase's* prompt, not a neighbor's.
 */
export function sectionForPhase<T extends { key: string }>(
  sections: T[], phase: { key: string } | undefined,
): T | undefined {
  return phase ? sections.find((s) => s.key === phase.key) : undefined;
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

export type GatePill = "pass" | "wait";

/** Gate pill for a phase, from the declarative gate (#897 Phase 4c removed the legacy
 *  pipeline gate): "pass" once the phase's gateRule is satisfied, else "wait". */
export function gatePill(phase: Phase): GatePill {
  return phase.status === "complete" || phase.status === "ahead" ? "pass" : "wait";
}

export type FooterKind = "back-to-current" | "jump-to-current" | "approve-continue" | "publish";

export interface FooterAction {
  kind: FooterKind;
  enabled: boolean;
  /** The active phase is an OPTIONAL stage the user can deliberately skip past — the advance bar
   *  shows a secondary "Skip stage" control alongside the primary action (#921). */
  canSkip?: boolean;
  /** The primary action is a user GATE OVERRIDE (#1285): the active stage's gate is NOT satisfied,
   *  but the "allow gate override" setting lets the user force past it. Rendered cautionary. */
  override?: boolean;
}

/**
 * The advance-bar's primary action, by where the selection sits relative to the active
 * phase. Browsing a future (locked) phase → back to current; a past phase → jump to
 * current; on the active phase → approve & continue (enabled when its gate is ready), or
 * publish when the whole plan is complete.
 *
 * `activeSkippable` (#921): the active phase is an enabled OPTIONAL stage that hasn't been decided
 * yet — so the user can either complete it (approve & continue) OR skip it. The flow stops on every
 * optional stage; skipping is how the USER, not the app, decides to move past one.
 */
export function footerAction(
  selectedIdx: number, activeIdx: number, planComplete: boolean, currentGateReady: boolean,
  activeSkippable = false,
): FooterAction {
  if (selectedIdx > activeIdx) return { kind: "back-to-current", enabled: true };
  if (selectedIdx < activeIdx) return { kind: "jump-to-current", enabled: true };
  if (planComplete) return { kind: "publish", enabled: true };
  return { kind: "approve-continue", enabled: currentGateReady, canSkip: activeSkippable };
}

/**
 * Resolve the final advance-bar action from the raw {@link footerAction} (#1285). For a blocking
 * "approve & continue" (gate not ready), it lights up in priority order:
 *   1. `pendingCount > 0` — there are drafted-but-unconfirmed sections; clicking confirms them (the
 *      normal one-click approval, NOT an override).
 *   2. `allowOverride` — the user enabled gate override in Settings; force-enable + flag `override`
 *      so the footer renders a cautionary "override gate & continue" that bypasses the gate.
 * Otherwise the action passes through unchanged (button stays disabled). Pure + unit-tested.
 */
export function resolveFooter(raw: FooterAction, pendingCount: number, allowOverride: boolean): FooterAction {
  if (raw.kind !== "approve-continue" || raw.enabled) return raw;
  if (pendingCount > 0) return { ...raw, enabled: true };
  if (allowOverride) return { ...raw, enabled: true, override: true };
  return raw;
}

/** Whether the active phase's gate is satisfied — enables "approve & continue". */
export function currentGateReady(sections: BlueprintSection[], signals: PlanSignals): boolean {
  const cur = currentSection(sections, signals);
  return !!cur && evalGate(cur.gateRule, signals).done;
}

/**
 * Whether the auto-complete-gates effect should confirm the active stage's pending sections (#1068):
 * the global flag is on, the planning autopilot is NOT driving (it owns confirmation then), and the
 * active stage actually has sections awaiting confirmation. The same "approve & continue" action the
 * user would click, minus the click — so it advances exactly the gates the manual path would.
 */
export function shouldAutoCompleteGate(autoOn: boolean, autopilotActive: boolean, pending: string[]): boolean {
  return autoOn && !autopilotActive && pending.length > 0;
}
