// Configurable execution topology (#204) — how plan nodes map onto the delivery
// substrate. Milestones, branching, and assignment are three projections of the
// same plan graph (when / where-code-lives / who), so they're configured together
// as coherent **strategy presets**, not independent knobs (which let users build
// incoherent combos). The topology is derived from (plan DAG + fleet + chosen
// strategy); this module is the strategy model + coherence critic + branch naming.
//
// Free of React / xterm / Tauri imports (matches the other planning modules).

/** The *when* projection. */
export type MilestoneAxis = "phase" | "release" | "iteration";
/** The *where-code-lives* projection. */
export type BranchGranularity = "per-issue" | "per-stream" | "stacked" | "trunk";
/** The *who* projection. */
export type AssignmentRule = "by-layer" | "by-dependency-wave" | "single-agent";
/** The merge/release flow. */
export type MergeFlow = "trunk" | "develop-main" | "gitflow";

export interface ExecutionStrategy {
  id: string;
  name: string;
  milestoneAxis: MilestoneAxis;
  branchGranularity: BranchGranularity;
  assignmentRule: AssignmentRule;
  mergeFlow: MergeFlow;
}

/** Coherent bundles. Pick one + override individual knobs only as a power user. */
export const STRATEGY_PRESETS: Record<string, ExecutionStrategy> = {
  "solo-trunk": {
    id: "solo-trunk",
    name: "Solo / trunk",
    milestoneAxis: "release",
    branchGranularity: "per-issue",
    assignmentRule: "single-agent",
    mergeFlow: "trunk",
  },
  "fleet-stream": {
    id: "fleet-stream",
    name: "Fleet / stream",
    milestoneAxis: "phase",
    branchGranularity: "per-stream",
    assignmentRule: "by-layer",
    mergeFlow: "develop-main",
  },
  "stacked-dependency": {
    id: "stacked-dependency",
    name: "Stacked / dependency-first",
    milestoneAxis: "phase",
    branchGranularity: "stacked",
    assignmentRule: "by-dependency-wave",
    mergeFlow: "develop-main",
  },
  "enterprise-gitflow": {
    id: "enterprise-gitflow",
    name: "Enterprise / gitflow",
    milestoneAxis: "release",
    branchGranularity: "per-issue",
    assignmentRule: "by-layer",
    mergeFlow: "gitflow",
  },
};

// ── Coherence critic ───────────────────────────────────────────────────────────

export interface CoherenceIssue {
  rule: string;
  message: string;
}

/**
 * Reject incoherent knob combinations (the reason to expose presets, not 12 free
 * dropdowns). Returns [] when coherent.
 *
 * - **stacked branches** follow the dependency DAG ⇒ assignment must be
 *   `by-dependency-wave`.
 * - **per-stream branches** mean an agent owns a stream/area ⇒ assignment must be
 *   `by-layer`.
 * - **single-agent** assignment can't drive multi-agent branch layouts
 *   (`per-stream` / `stacked`).
 */
export function validateStrategyCoherence(s: ExecutionStrategy): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];
  if (s.branchGranularity === "stacked" && s.assignmentRule !== "by-dependency-wave") {
    issues.push({
      rule: "stacked-requires-wave",
      message: "stacked branches follow the dependency DAG — assignment must be by-dependency-wave",
    });
  }
  if (s.branchGranularity === "per-stream" && s.assignmentRule !== "by-layer") {
    issues.push({
      rule: "per-stream-requires-by-layer",
      message: "per-stream branches require by-layer assignment (a stream owns an area)",
    });
  }
  if (
    s.assignmentRule === "single-agent" &&
    (s.branchGranularity === "per-stream" || s.branchGranularity === "stacked")
  ) {
    issues.push({
      rule: "single-agent-not-multi",
      message: `single-agent assignment is incompatible with ${s.branchGranularity} branches (which imply multiple agents)`,
    });
  }
  return issues;
}

/** True when a strategy has no coherence issues. */
export function isCoherent(s: ExecutionStrategy): boolean {
  return validateStrategyCoherence(s).length === 0;
}

// ── Branch naming (carries the id so #199 can map branch → issue → DAG) ─────────

/** Lowercase-hyphen slug of a short description, capped for branch readability. */
export function slugify(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}

export interface BranchTarget {
  /** Issue number (no `#`). */
  issue?: number;
  /** Stream/epic id. */
  stream?: string;
  /** Short description. */
  desc?: string;
}

/**
 * Derive a branch name for a strategy. `per-stream` uses the stream id; everything
 * else is `{issue}-{slug(desc)}`. Always carries an id so the coordinator (#199) can
 * map branch → issue/stream → DAG.
 */
export function branchNameFor(strategy: ExecutionStrategy, target: BranchTarget): string {
  if (strategy.branchGranularity === "per-stream" && target.stream) {
    return target.stream;
  }
  const base = target.issue != null ? `${target.issue}` : (target.stream ?? "work");
  const slug = target.desc ? slugify(target.desc) : "";
  return slug ? `${base}-${slug}` : base;
}
