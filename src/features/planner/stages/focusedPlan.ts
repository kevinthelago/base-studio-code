// Focused planner pane (#652) — the pure model behind the one-stage-at-a-time right
// pane. It wraps the EXISTING blueprint/signal/gate logic (stageStatus / currentStage
// / evalGate) into a navigable "stage" view: which stages are visible, each one's status
// (complete / active / locked / upcoming), the gate pill, and the advance-bar action.
// Pure + serializable so it's fully unit-testable; no React/Tauri.

import {
  enabledStages, currentStage, stageStatus, stageSkipped,
  type BlueprintStage,
} from "./blueprints";
import { evalGate, gateReasons, type PlanSignals } from "./stageGate";

// "complete" = done IN sequence (at/behind the current position); "ahead" = done OUT of
// sequence (gate met past the current position — "banked"); "skipped" = an OPTIONAL section
// the USER deliberately skipped (#921 — the flow now STOPS on every optional stage; the only way
// past one without completing it is a user skip). The rail renders each distinctly so a future
// stage finishing early / a deliberately skipped stage don't read as in-order progress or as a
// not-yet-reached stage (#668).
export type StageStatus = "complete" | "ahead" | "active" | "skipped" | "locked" | "upcoming";

export interface Stage {
  key: string;
  name: string;
  glyph: string;
  blurb: string;
  /** The section's human gate description. */
  gate: string;
  index: number;
  total: number;
  status: StageStatus;
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
 * The visible stage list: enabled, non-N/A sections in declared order, each tagged with
 * its status — complete (gate passed), active (the current reached stage), locked (a
 * dependency is unmet), or upcoming (reachable but not yet current).
 */
export function stagesFrom(sections: BlueprintStage[], signals: PlanSignals): Stage[] {
  const current = currentStage(sections, signals);
  const visible = enabledStages(sections)
    .map((s) => ({ s, st: stageStatus(s, sections, signals) }))
    .filter(({ st }) => st.status !== "na");
  // The current position among visible stages; everything complete PAST it is "ahead".
  const activeIdx = current ? visible.findIndex(({ s }) => s.key === current.key) : visible.length;
  return visible.map(({ s, st }, i) => {
    let status: StageStatus;
    // A deliberately user-skipped optional stage reads as "skipped", not "complete" — even though
    // it counts as resolved for the frontier/gate (`stageDone`). Check this first (#921).
    if (stageSkipped(s, signals)) status = "skipped";
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
 * The blueprint section for a stage, resolved BY KEY (#815). `stages` is a FILTERED subset of the
 * raw section list (disabled / not-applicable sections like `ui` are dropped by {@link stagesFrom}),
 * so indexing the raw sections with a stage index lands on the wrong section once any earlier one is
 * dropped. The conductor uses this to inject the *active stage's* prompt, not a neighbor's.
 */
export function sectionForStage<T extends { key: string }>(
  sections: T[], stage: { key: string } | undefined,
): T | undefined {
  return stage ? sections.find((s) => s.key === stage.key) : undefined;
}

export type ConnectorKind = "solid" | "partial" | "dashed" | "dim";

/** The rail connector AFTER node `i` (#668): solid traces the walked in-sequence path,
 *  partial leaves the current node, dashed reaches a banked-ahead node, dim otherwise. */
export function connectorKind(stages: Stage[], i: number): ConnectorKind {
  const role = stages[i]?.status;
  const next = stages[i + 1]?.status;
  // A banked-ahead node (done out of sequence) is reached by a dashed connector.
  if (role === "ahead" || next === "ahead") return "dashed";
  // The walked path is green UP TO the current node: every connector positioned BEFORE the
  // active node is solid — including the one leaving a skipped/optional section — so the
  // green leads INTO the current node, never out of it. Beyond the current node: dim (#668).
  const activeIdx = stages.findIndex((p) => p.status === "active");
  const frontier = activeIdx >= 0 ? activeIdx : stages.length;
  return i < frontier ? "solid" : "dim";
}

/** Index of the active stage (else the last) — what the selection auto-follows. */
export function activeIndex(stages: Stage[]): number {
  const a = stages.findIndex((p) => p.status === "active");
  return a >= 0 ? a : Math.max(0, stages.length - 1);
}

/** Clamp an index into [0, count-1] (0 when empty) — guards against a shrunk stage list
 *  after a blueprint switch / clear. */
export function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, i), count - 1);
}

export type GatePill = "pass" | "wait";

/** Gate pill for a stage, from the declarative gate (#897 Phase 4c removed the legacy
 *  pipeline gate): "pass" once the stage's gateRule is satisfied, else "wait". */
export function gatePill(stage: Stage): GatePill {
  return stage.status === "complete" || stage.status === "ahead" ? "pass" : "wait";
}

export type FooterKind = "back-to-current" | "jump-to-current" | "approve-continue" | "route-design" | "publish";

export interface FooterAction {
  kind: FooterKind;
  enabled: boolean;
  /** A Skip control is rendered beside the primary action — on EVERY active stage (#2533), so the
   *  footer reads as a consistent Continue + Skip pair regardless of whether the stage is optional. */
  canSkip?: boolean;
  /** Whether that Skip control is ACTIONABLE (#2533): always on an optional stage; on a required
   *  stage only when the user enabled "allow gate override" (#1285) — otherwise it renders disabled
   *  with an explanatory tooltip. Distinct from `canSkip`, which only governs whether it's shown. */
  skipEnabled?: boolean;
}

/**
 * The advance-bar's primary action, by where the selection sits relative to the active
 * stage. Browsing a future (locked) stage → back to current; a past stage → jump to
 * current; on the active stage → approve & continue (enabled when its gate is ready), or
 * publish when the whole plan is complete.
 *
 * `canSkip` (#2533): the Skip control is shown on EVERY active stage (both approve-continue and
 * route-design), giving a uniform Continue + Skip pair. Whether Skip is actually clickable is
 * decided later by {@link resolveFooter} (`skipEnabled`), which knows if the stage is optional and
 * whether gate-override is on. Navigation and publish never offer skip.
 */
export function footerAction(
  selectedIdx: number, activeIdx: number, planComplete: boolean, currentGateReady: boolean,
  routeDesign = false,
): FooterAction {
  if (selectedIdx > activeIdx) return { kind: "back-to-current", enabled: true };
  if (selectedIdx < activeIdx) return { kind: "jump-to-current", enabled: true };
  if (planComplete) return { kind: "publish", enabled: true };
  // #2121: the active UI stage whose design is missing or stale → the primary action ROUTES the
  // design (sync the skeleton + mark it current) instead of advancing. Skip is still offered (#2533)
  // — routing and skipping the stage are both valid choices, and hiding skip here made the UI pane's
  // button set flicker as the design state changed.
  if (routeDesign) return { kind: "route-design", enabled: true, canSkip: true };
  return { kind: "approve-continue", enabled: currentGateReady, canSkip: true };
}

/**
 * Resolve the final advance-bar action from the raw {@link footerAction}. Two independent axes:
 *
 * PRIMARY — a blocking "approve & continue" (gate not ready) lights up when `pendingCount > 0`:
 * there are drafted-but-unconfirmed sections and clicking confirms them (the one-click approval).
 * Otherwise the primary stays disabled ("gate blocking…").
 *
 * SKIP (#2533) — for any action that shows a Skip control (`canSkip`), `skipEnabled` is set: always
 * on an OPTIONAL stage, and on a REQUIRED stage only when the user enabled gate override (#1285).
 * Skip is the single, uniform "move past without completing" affordance — it replaces the old
 * cautionary primary-morph, so both optional-skip and required-override render the same way.
 *
 * Pure + unit-tested.
 */
export function resolveFooter(
  raw: FooterAction, pendingCount: number, allowOverride: boolean, activeOptional: boolean,
): FooterAction {
  // Skip actionability (only meaningful where a Skip control is shown).
  const withSkip = raw.canSkip ? { ...raw, skipEnabled: activeOptional || allowOverride } : raw;
  // One-click confirm lights the blocking primary; nothing else force-enables it now.
  if (withSkip.kind !== "approve-continue" || withSkip.enabled) return withSkip;
  if (pendingCount > 0) return { ...withSkip, enabled: true };
  return withSkip;
}

/** Whether the active stage's gate is satisfied — enables "approve & continue". */
export function currentGateReady(sections: BlueprintStage[], signals: PlanSignals): boolean {
  const cur = currentStage(sections, signals);
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
