// Modular planning stages (#512/#515). The registry is the single source of
// truth that ties each planning stage's bar, gate, and prompt module together
// by a stable `id`. Everything is pure here — no React/Tauri — so the gating
// logic is unit-testable in isolation, and both the progress bar and the Rust
// prompt assembler can key off the same stage ids.
//
// Blueprint schema (#514): a Blueprint is a named, reusable configuration of
// which stages are active and what per-stage options apply. See Blueprints.tsx.

/** All valid stage identifiers, in pipeline order. */
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
  /** Short display label shown in the PlanStageBar. */
  label: string;
  /** One-line description of what this stage produces (shown in Blueprint editor). */
  description: string;
  /** Whether the stage can be toggled off in a Blueprint.
   *  Required stages (context, structure) are always included. */
  optional: boolean;
  /** Whether this stage produces a visible output file the app polls for
   *  (e.g. phases.json, fleet.json). Informational only — drives tooltip copy. */
  hasOutputFile: boolean;
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

// ── The canonical stage registry ─────────────────────────────────────────────
// Default order puts `ui` before `structure` so issues can reference approved
// screens (#510). Dependencies encode the real prerequisites; because a disabled
// dependency is treated as satisfied, turning any stage off never deadlocks others.
export const PLAN_STAGES: Stage[] = [
  {
    id: "context",
    label: "Context",
    description: "Goal, users, scope, stack, and architecture discovery",
    optional: false,
    hasOutputFile: false,
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
    description: "Link repositories — the app clones each into the project hub",
    optional: true,
    hasOutputFile: true,  // repos.json
    dependsOn: [],
    defaultEnabled: true,
    gate: (s) => ({ done: s.repoCount > 0, fraction: s.repoCount > 0 ? 1 : 0 }),
  },
  {
    id: "ui",
    label: "UI",
    description: "Screen skeletons and live preview via <ui_preview> tags",
    optional: true,
    hasOutputFile: false,
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
    description: "Feature workshop: phases.json + agent-ready issues.json",
    optional: false,
    hasOutputFile: true,  // phases.json + issues.json
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
    description: "Agent fleet plan (fleet.json): non-overlapping streams + least-privilege profiles",
    optional: true,
    hasOutputFile: true,  // fleet.json
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
    description: "Cron and on-demand automations (emit <automation_assign> tags)",
    optional: true,
    hasOutputFile: false,
    dependsOn: ["structure"],
    defaultEnabled: true,
    gate: (s) => ({ done: s.automationsAck, fraction: s.automationsAck ? 1 : 0 }),
  },
  {
    id: "skills",
    label: "Skills",
    description: "Reusable skill procedures for the fleet (skills.json)",
    optional: true,
    hasOutputFile: true,  // skills.json
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

/**
 * The current ("reached") stage: the first enabled + applicable stage that is neither
 * complete nor locked — the in-progress frontier. When every stage is complete it
 * falls back to the last enabled+applicable stage, so a finished plan still resolves
 * to one. Drives which pipelines' second screens render in the planning page.
 */
export function currentStage(cfg: StageConfig, s: PlanStageState): Stage | undefined {
  const stages = enabledOrderedStages(cfg).filter((st) => applies(st, s));
  const active = stages.find((st) => stageStatus(st, s, cfg).status === "in-progress");
  return active ?? stages[stages.length - 1];
}

/** The default set of enabled stage ids for a new plan. */
export const DEFAULT_ENABLED_STAGES: StageId[] = PLAN_STAGES.map(s => s.id);

/** Return true if a StageId string is valid. */
export function isStageId(value: string): value is StageId {
  return PLAN_STAGES.some(s => s.id === value);
}

/** Lookup a stage by its id. */
export function stageById(id: StageId): Stage | undefined {
  return STAGE_BY_ID[id];
}

// ── Per-stage options (#514) ──────────────────────────────────────────────────
// Each stage may carry stage-specific options that a Blueprint can set.

/** Options for the "context" stage. */
export interface ContextStageOptions {
  /** Which discovery dimensions to enable. Empty ⇒ all. */
  dimensions?: string[];
}

/** Options for the "ui" stage. */
export interface UiStageOptions {
  /** Which screens to scaffold. Empty ⇒ all discovered. */
  screens?: string[];
  /** "2d" or "3d" preview mode. */
  previewMode?: "2d" | "3d";
}

/** Options for the "structure" stage. */
export interface StructureStageOptions {
  /** Workshop mode: feature-by-feature (new projects) vs section-by-section (existing). */
  workshopMode?: "feature" | "section";
}

/** Options for the "permissions" stage. */
export interface PermissionsStageOptions {
  /** Recommended concurrent session count override. 0 = planner decides. */
  recommendedSessions?: number;
}

/** Union of all per-stage option shapes. Index by StageId. */
export interface StageOptionsMap {
  context?:     ContextStageOptions;
  repos?:       Record<string, never>;
  ui?:          UiStageOptions;
  structure?:   StructureStageOptions;
  permissions?: PermissionsStageOptions;
  automations?: Record<string, never>;
  skills?:      Record<string, never>;
}

// ── Blueprint schema (#514) — reusable stage-pipeline configs ─────────────────
// A Blueprint is a named, saveable configuration of which stages are active and
// what per-stage options apply. It is the schema pipeline-ui (#529) needs.

/** A named, reusable configuration of the planner's stage pipeline. */
export interface Blueprint {
  /** Stable slug, lowercase-hyphen (e.g. "quick-context", "full-plan"). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description of what this Blueprint produces. */
  description: string;
  /** Which stages are enabled. Required stages are always included regardless. */
  enabledStages: StageId[];
  /** Per-stage option overrides. */
  stageOptions?: StageOptionsMap;
  /** Whether this Blueprint was user-created (as opposed to a built-in preset). */
  custom?: boolean;
}

/** Built-in Blueprint presets available without user customization. */
export const BUILT_IN_BLUEPRINTS: Blueprint[] = [
  {
    id: "full-plan",
    name: "Full plan",
    description: "All stages: context → repos → UI → structure → permissions → automations → skills",
    enabledStages: [...DEFAULT_ENABLED_STAGES],
    custom: false,
  },
  {
    id: "quick-context",
    name: "Quick context",
    description: "Context and structure only — fastest path to agent-ready issues",
    enabledStages: ["context", "repos", "structure"],
    custom: false,
  },
  {
    id: "existing-project",
    name: "Existing project",
    description: "Section-by-section migration of an existing codebase into the plan",
    enabledStages: ["context", "repos", "structure", "permissions"],
    stageOptions: {
      structure: { workshopMode: "section" },
    },
    custom: false,
  },
  {
    id: "ui-first",
    name: "UI first",
    description: "Context → screen skeletons → structure → fleet",
    enabledStages: ["context", "repos", "ui", "structure", "permissions"],
    custom: false,
  },
];

/** Parse a raw JSON string into a Blueprint array. Tolerant of malformed input. */
export function parseBlueprintsFile(raw: string): Blueprint[] {
  if (!raw || !raw.trim()) return [];
  try {
    const j: unknown = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j.filter((b): b is Blueprint => {
      if (!b || typeof b !== "object") return false;
      const o = b as Record<string, unknown>;
      return typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.enabledStages);
    });
  } catch {
    return [];
  }
}

/** Merge a Blueprint's enabledStages with the required stages so required stages
 *  can never be dropped. Returns a deduped, ordered list. */
export function resolveEnabledStages(blueprint: Blueprint): StageId[] {
  const required = PLAN_STAGES.filter(s => !s.optional).map(s => s.id);
  const merged = new Set([...required, ...blueprint.enabledStages]);
  return PLAN_STAGES.filter(s => merged.has(s.id)).map(s => s.id);
}
