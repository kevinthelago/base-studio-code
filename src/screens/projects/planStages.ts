// Modular planning stages (#512). The registry is the single source of truth that
// ties each planning stage's bar, gate, and (later) prompt module together by a
// stable `id`. Everything is pure here — no React/Tauri — so the gating logic is
// unit-testable in isolation, and both the progress bar and the Rust prompt
// assembler can key off the same stage ids.

export type StageId =
  | "context"
  | "repos"
  | "ui"
  | "structure"
  | "permissions"
  | "automations"
  | "skills";

/**
 * Normalized snapshot the gates read. A later slice builds this from the live plan
 * data (sections, repos, fleet, …) at the call site; the gates only ever see this
 * shape, which keeps them pure and testable. Use {@link buildPlanStageState} to
 * construct one with safe defaults for any field not yet known.
 */
export interface PlanStageState {
  /** Discovery topics resolved (confirmed or explicitly skipped) vs total surfaced,
   *  plus whether the core four (goal/scope/stack/architecture) are confirmed. */
  context: { resolved: number; total: number; coreConfirmed: boolean };
  /** Repositories linked to the project. */
  repoCount: number;
  /** Whether the project needs a UI at all — drives the UI stage's applicability. */
  requiresUi: boolean;
  /** Required screens approved vs total (only meaningful when requiresUi). */
  ui: { approved: number; total: number };
  /** Structure: the roadmap is confirmed and granular issues exist. */
  phasesConfirmed: boolean;
  issueCount: number;
  /** Fleet: streams defined, and each has a profile/flow set. */
  fleet: { streams: number; profilesComplete: boolean };
  /** Automations reviewed/acknowledged (may legitimately be zero). */
  automationsAck: boolean;
  /** Skills assigned/acknowledged (may legitimately be zero). */
  skillsAck: boolean;
}

/** Status of a stage for rendering. `na` = not applicable to this project. */
export type StageStatus = "locked" | "in-progress" | "complete" | "na";

export interface Stage {
  id: StageId;
  label: string;
  /** Prerequisite stages. A disabled (or N/A) dependency counts as satisfied. */
  dependsOn: StageId[];
  defaultEnabled: boolean;
  /** When present and false, the stage is N/A for this project (auto-satisfied,
   *  and hidden by the bar). Used by the UI stage via `requiresUi`. */
  applies?: (s: PlanStageState) => boolean;
  /** Stage-local completion + 0..1 progress, ignoring dependencies. */
  gate: (s: PlanStageState) => { done: boolean; fraction: number };
}

/** Per-project (or per-blueprint) on/off + ordering of the stages (#512). */
export interface StageConfig {
  enabled: Record<StageId, boolean>;
  order: StageId[];
}

// ── The canonical stage registry ────────────────────────────────────────────────
// Default order puts `ui` before `structure` so issues can reference approved
// screens (#510). Dependencies encode the real prerequisites; because a disabled
// dependency is treated as satisfied, turning any stage off never deadlocks others.
export const PLAN_STAGES: Stage[] = [
  {
    id: "context",
    label: "Context",
    dependsOn: [],
    defaultEnabled: true,
    gate: (s) => ({
      done: s.context.coreConfirmed && s.context.total > 0 && s.context.resolved >= s.context.total,
      fraction: s.context.total > 0 ? s.context.resolved / s.context.total : 0,
    }),
  },
  {
    id: "repos",
    label: "Repos",
    dependsOn: [],
    defaultEnabled: true,
    gate: (s) => ({ done: s.repoCount > 0, fraction: s.repoCount > 0 ? 1 : 0 }),
  },
  {
    id: "ui",
    label: "UI",
    dependsOn: ["context"],
    defaultEnabled: true,
    applies: (s) => s.requiresUi,
    gate: (s) => ({
      done: s.ui.total > 0 && s.ui.approved >= s.ui.total,
      fraction: s.ui.total > 0 ? s.ui.approved / s.ui.total : 0,
    }),
  },
  {
    id: "structure",
    label: "Structure",
    dependsOn: ["context", "repos", "ui"],
    defaultEnabled: true,
    gate: (s) => ({
      done: s.phasesConfirmed && s.issueCount > 0,
      fraction: (s.phasesConfirmed ? 0.5 : 0) + (s.issueCount > 0 ? 0.5 : 0),
    }),
  },
  {
    id: "permissions",
    label: "Permissions",
    dependsOn: ["structure"],
    defaultEnabled: true,
    gate: (s) => ({
      done: s.fleet.streams > 0 && s.fleet.profilesComplete,
      fraction: s.fleet.streams > 0 ? (s.fleet.profilesComplete ? 1 : 0.5) : 0,
    }),
  },
  {
    id: "automations",
    label: "Automations",
    dependsOn: ["structure"],
    defaultEnabled: true,
    gate: (s) => ({ done: s.automationsAck, fraction: s.automationsAck ? 1 : 0 }),
  },
  {
    id: "skills",
    label: "Skills",
    dependsOn: [],
    defaultEnabled: true,
    gate: (s) => ({ done: s.skillsAck, fraction: s.skillsAck ? 1 : 0 }),
  },
];

export const STAGE_BY_ID: Record<StageId, Stage> = Object.fromEntries(
  PLAN_STAGES.map((s) => [s.id, s]),
) as Record<StageId, Stage>;

/** All-on config in the registry's default order — reproduces today's behavior. */
export function defaultStageConfig(): StageConfig {
  return {
    enabled: Object.fromEntries(PLAN_STAGES.map((s) => [s.id, s.defaultEnabled])) as Record<StageId, boolean>,
    order: PLAN_STAGES.map((s) => s.id),
  };
}

/** Fill a partial snapshot with safe defaults so callers needn't specify every field. */
export function buildPlanStageState(p: Partial<PlanStageState> = {}): PlanStageState {
  return {
    context: p.context ?? { resolved: 0, total: 0, coreConfirmed: false },
    repoCount: p.repoCount ?? 0,
    requiresUi: p.requiresUi ?? false,
    ui: p.ui ?? { approved: 0, total: 0 },
    phasesConfirmed: p.phasesConfirmed ?? false,
    issueCount: p.issueCount ?? 0,
    fleet: p.fleet ?? { streams: 0, profilesComplete: false },
    automationsAck: p.automationsAck ?? false,
    skillsAck: p.skillsAck ?? false,
  };
}

function applies(stage: Stage, s: PlanStageState): boolean {
  return stage.applies ? stage.applies(s) : true;
}

/** A dependency is satisfied when it is disabled, N/A, or its own gate is done. */
function depSatisfied(depId: StageId, s: PlanStageState, cfg: StageConfig): boolean {
  if (!cfg.enabled[depId]) return true;
  const dep = STAGE_BY_ID[depId];
  if (!dep) return true;
  if (!applies(dep, s)) return true;
  return dep.gate(s).done;
}

/**
 * Resolve a stage's render status + bar fill, honoring applicability, its gate, and
 * its (enabled) dependencies. A disabled or N/A dependency never blocks a stage.
 */
export function stageStatus(stage: Stage, s: PlanStageState, cfg: StageConfig): { status: StageStatus; fraction: number } {
  if (!applies(stage, s)) return { status: "na", fraction: 0 };
  const g = stage.gate(s);
  if (g.done) return { status: "complete", fraction: 1 };
  const locked = stage.dependsOn.some((d) => !depSatisfied(d, s, cfg));
  return { status: locked ? "locked" : "in-progress", fraction: g.fraction };
}

/** The enabled stages, in the configured order (what the bar renders). */
export function enabledOrderedStages(cfg: StageConfig): Stage[] {
  return cfg.order.filter((id) => cfg.enabled[id]).map((id) => STAGE_BY_ID[id]).filter(Boolean);
}
