// Lifecycle-aware planning (#458): project lifecycle state derivation and
// refactor/optimization fleet generation. Pure (no React / Tauri) so everything
// is unit-testable without a live app or GitHub.

import type { FleetPlan, AgentStream } from "../screens/planner/planSections";
import type { PlanIssue } from "../screens/planner/planIssues";

// ── Lifecycle state ───────────────────────────────────────────────────────────

export type LifecycleState = "new" | "active" | "near-complete";

/** Signals used to derive the lifecycle state. */
export interface LifecycleSignals {
  /** Whether the project is published (activeProjectId is set). */
  isExisting: boolean;
  /** Total plan issues (from phaseStructure rollup). */
  totalIssues: number;
  /** Issues marked closed on GitHub (from ghProgress / phaseStructure). */
  closedIssues: number;
  /** 0–1 plan grade score from planGrade; undefined when no issues exist. */
  planGradeScore?: number;
}

// A project is "near-complete" when ≥75% of its issues are closed, OR when
// ≥50% are closed AND the plan grade is B or better (≥0.75). Both thresholds
// are conservative to avoid false positives on small plans.
const NEAR_COMPLETE_RATIO        = 0.75;
const NEAR_COMPLETE_RATIO_GRADED = 0.50;
const NEAR_COMPLETE_GRADE_B      = 0.75;

/**
 * Derive a project's lifecycle state from its current signals.
 * "new" → not yet published; "active" → in flight; "near-complete" → most
 * work closed, a refactor pass is appropriate.
 */
export function deriveLifecycleState(s: LifecycleSignals): LifecycleState {
  if (!s.isExisting) return "new";
  const ratio = s.totalIssues > 0 ? s.closedIssues / s.totalIssues : 0;
  const nearComplete =
    ratio >= NEAR_COMPLETE_RATIO ||
    (ratio >= NEAR_COMPLETE_RATIO_GRADED && (s.planGradeScore ?? 0) >= NEAR_COMPLETE_GRADE_B);
  return nearComplete ? "near-complete" : "active";
}

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  "new":           "drafting",
  "active":        "expanding",
  "near-complete": "near-complete",
};

// ── Refactor fleet ────────────────────────────────────────────────────────────

// Fixed split: frontend (src/**) and Rust backend (src-tauri/**). These two
// globs are guaranteed non-overlapping regardless of project structure — an
// agent whose repo has no src-tauri layer will simply find nothing to refactor
// in that stream and self-report done quickly. Using two streams (not one) lets
// two agents work in parallel and keeps concerns separate.
const FE_OWNS   = "src/**";
const BE_OWNS   = "src-tauri/**";

/**
 * Build a refactor/optimization fleet plan for the given set of repos. Produces
 * two non-overlapping streams per repo — one for the JS/TS frontend layer
 * (`src/**`) and one for the Rust backend layer (`src-tauri/**`) — plus a
 * coordinating director when more than one stream is generated. The fleet reuses
 * the existing `fleetStartProject` machinery (worktrees, profiles, flows).
 *
 * Stream ids are lowercase-hyphen slugs (they become git branch names).
 */
export function buildRefactorFleet(repos: string[]): FleetPlan {
  const streams: AgentStream[] = repos.flatMap((repo) => {
    const short = (repo.split("/")[1] ?? repo).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const fe: AgentStream = {
      id:         `${short}-refactor-fe`,
      name:       `${short} — frontend refactor`,
      repo,
      owns:       [FE_OWNS],
      issues:     [],
      dependsOn:  [],
      flow: { autonomy: "confirm", push: "push-confirm", trigger: "per-stage", gate: "hard" },
    };
    const be: AgentStream = {
      id:         `${short}-refactor-be`,
      name:       `${short} — backend refactor`,
      repo,
      owns:       [BE_OWNS],
      issues:     [],
      dependsOn:  [],
      flow: { autonomy: "confirm", push: "push-confirm", trigger: "per-stage", gate: "hard" },
    };
    return [fe, be];
  });

  return {
    recommended: streams.length,
    reasoning:   `Refactor pass: ${repos.length} repo${repos.length !== 1 ? "s" : ""} split into non-overlapping frontend + backend streams with confirm-gate push policy so every change is reviewed before landing.`,
    streams,
    director: {
      enabled: true,
      role:    "async integrator for refactor pass: review and merge refactor PRs, coordinate between streams, keep milestones current",
    },
    strategy: "pr-ci",
  };
}

// ── Refactor issues ───────────────────────────────────────────────────────────

// Standard refactor work items generated per repo. Each is a `PlanIssue` ready
// to be published as a GitHub issue and assigned to the appropriate stream.
interface RefactorTemplate {
  title:      string;
  area:       "fe" | "be";
  acceptance: string[];
  labels:     string[];
}

const REFACTOR_TEMPLATES: RefactorTemplate[] = [
  {
    title:      "Dead-code sweep — remove unused exports, dead files, and unreferenced deps",
    area:       "fe",
    acceptance: [
      "TypeScript build passes with --noUnusedLocals and --noUnusedParameters",
      "No unreachable top-level exports remain in src/**",
      "package.json has no unused direct dependencies",
      "Removal PR passes CI",
    ],
    labels: ["type:refactor", "area:dead-code"],
  },
  {
    title:      "Simplification pass — reduce complexity, consolidate duplication, tighten APIs",
    area:       "fe",
    acceptance: [
      "No function exceeds 60 lines without justification",
      "Duplicated logic consolidated into shared helpers",
      "Component/module surface area (exports) trimmed to what callers actually use",
      "Tests still pass with no mocks added",
    ],
    labels: ["type:refactor", "area:simplification"],
  },
  {
    title:      "Rust backend refactor — dead code, unused deps, clippy clean",
    area:       "be",
    acceptance: [
      "cargo clippy -- -D warnings passes",
      "No dead_code warnings in src-tauri/**",
      "Cargo.toml has no unused crate dependencies",
      "cargo test passes",
    ],
    labels: ["type:refactor", "area:backend"],
  },
  {
    title:      "Performance pass — optimize hot paths, eliminate unnecessary re-renders",
    area:       "fe",
    acceptance: [
      "React DevTools profiler shows no avoidable re-renders on the main planning page",
      "No synchronous expensive computation in render paths (moved to useMemo / Web Worker)",
      "Network waterfall: no sequential fetches that could be parallelised",
    ],
    labels: ["type:refactor", "area:performance"],
  },
];

/**
 * Generate standard agent-ready refactor {@link PlanIssue}s for `repos`, with
 * each issue assigned to its owning stream from {@link buildRefactorFleet}.
 * Issues are given a `phase` of `"Refactor"` so they can be published into a
 * dedicated milestone without touching the existing feature milestones.
 */
export function buildRefactorIssues(repos: string[]): PlanIssue[] {
  const out: PlanIssue[] = [];
  for (const repo of repos) {
    const short = (repo.split("/")[1] ?? repo).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const tpl of REFACTOR_TEMPLATES) {
      const streamId = `${short}-refactor-${tpl.area}`;
      out.push({
        ref:        `refactor:${short}:${tpl.area}:${tpl.labels[1]?.replace("area:", "") ?? tpl.area}`,
        title:      tpl.title,
        phase:      "Refactor",
        acceptance: tpl.acceptance,
        owns:       tpl.area === "fe" ? [FE_OWNS] : [BE_OWNS],
        dependsOn:  [],
        labels:     [...tpl.labels, `stream:${streamId}`],
        repo,
        stream:     streamId,
      });
    }
  }
  return out;
}
