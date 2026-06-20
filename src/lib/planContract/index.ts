// Blueprint-driven plan-contract validator (#568 REL-tier0).
//
// Asserts structural correctness of a planner's output artifacts:
//   - required/enabled stage sections present, non-empty, and confirmed
//   - issues.json agent-ready (unique refs, deps resolve, resolvable phase)
//   - fleet.json stream `owns` globs pairwise disjoint
//   - no placeholder gaps in required sections
//
// Pure — no React / Tauri / AI. Runs in CI against fixture plans; fails closed
// on contract violations. Reuses validateIssues (planIssues.ts) for issue checks.

import { parseIssuesFile, validateIssues } from "../../screens/planner/planIssues";
import { parseFleetFile } from "../../screens/planner/planSections";
import { parsePhases } from "../../screens/planner/github/ghStructure";

// ── Blueprint types ─────────────────────────────────────────────────────────────

/** One planning stage with its required sections and confirmation requirements. */
export interface StageDef {
  /** Display name for this stage (e.g. "Context", "Structure"). */
  name: string;
  /** Whether this stage is enabled and must be checked. */
  enabled: boolean;
  /** Section keys that must be present and non-empty (no placeholder content). */
  requiredSections: string[];
  /** Subset of requiredSections that must also be confirmed by the user. */
  requiredConfirmed: string[];
}

/** The contract a plan output must satisfy. */
export interface PlanBlueprint {
  stages: StageDef[];
  /** When true, issues.json (if present and non-empty) must be agent-ready. */
  requiresAgentReadyIssues: boolean;
  /** When true, fleet.json stream owns globs must be pairwise disjoint. */
  requiresDisjointOwns: boolean;
}

/** The minimum blueprint that every plan must satisfy: Context sections confirmed,
 *  agent-ready issues, and disjoint fleet stream ownership. */
export const DEFAULT_BLUEPRINT: PlanBlueprint = {
  stages: [
    {
      name: "Context",
      enabled: true,
      requiredSections: ["goal", "scope", "stack", "architecture"],
      requiredConfirmed: ["goal", "scope", "stack", "architecture"],
    },
    {
      name: "Structure",
      enabled: true,
      requiredSections: ["phases"],
      requiredConfirmed: [],
    },
  ],
  requiresAgentReadyIssues: true,
  requiresDisjointOwns: true,
};

// ── Plan artifact input ─────────────────────────────────────────────────────────

/** The output artifacts produced by a completed planning session. */
export interface PlanArtifacts {
  /** Section content by key (e.g. "goal" → markdown string). */
  sections: Record<string, string>;
  /** Keys of sections explicitly confirmed by the user. */
  confirmedSections: string[];
  /** Raw JSON content of `issues.json`; empty string if absent. */
  issuesJson: string;
  /** Raw JSON content of `phases.json`; empty string if absent. */
  phasesJson: string;
  /** Raw JSON content of `fleet.json`; empty string if absent. */
  fleetJson: string;
}

// ── Contract report ─────────────────────────────────────────────────────────────

export interface ContractViolation {
  /** Short machine-readable code (e.g. "STAGE_SECTION_MISSING"). */
  code: string;
  message: string;
}

export interface ContractWarning {
  code: string;
  message: string;
}

export interface ContractReport {
  /** True only when there are zero violations. */
  ok: boolean;
  violations: ContractViolation[];
  /** Non-fatal issues that don't block the contract but should be surfaced. */
  warnings: ContractWarning[];
}

// ── findPlanGaps ────────────────────────────────────────────────────────────────

/** A section that is missing, empty, or contains only placeholder content. */
export interface PlanGap {
  key: string;
  reason: "missing" | "empty" | "placeholder";
}

const PLACEHOLDER_RE = /\b(TODO|TBD|PLACEHOLDER)\b/i;

function bodyContent(content: string): string {
  // Strip markdown headings and whitespace to assess whether real prose exists.
  return content.replace(/^#{1,6}[^\n]*\n?/gm, "").trim();
}

function isPlaceholder(content: string): boolean {
  if (PLACEHOLDER_RE.test(content)) return true;
  // A section is a placeholder if there's essentially no body after stripping headings.
  return bodyContent(content).length < 10;
}

/**
 * Find gaps in required plan sections: missing, empty, or placeholder-only.
 * Pure — does not check whether sections are confirmed.
 */
export function findPlanGaps(sections: Record<string, string>, requiredKeys: string[]): PlanGap[] {
  const gaps: PlanGap[] = [];
  for (const key of requiredKeys) {
    const content = sections[key];
    if (content === undefined || content === null) {
      gaps.push({ key, reason: "missing" });
    } else if (!content.trim()) {
      gaps.push({ key, reason: "empty" });
    } else if (isPlaceholder(content)) {
      gaps.push({ key, reason: "placeholder" });
    }
  }
  return gaps;
}

// ── findOwnsOverlaps ────────────────────────────────────────────────────────────

export interface OwnsOverlap {
  streamA: string;
  streamB: string;
  globA: string;
  globB: string;
}

/** Extract the literal path prefix before the first glob special character. */
function literalPrefix(glob: string): string {
  const normalized = glob.replace(/\\/g, "/");
  const m = normalized.match(/^([^*?[{]*)/);
  return m ? m[1] : "";
}

/**
 * Return true if two path globs could match the same file.
 * Heuristic: if one glob's literal prefix is a string-prefix of the other glob
 * (after path normalization), the globs' match sets overlap.
 */
function globsOverlap(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/");
  const nb = b.replace(/\\/g, "/");
  if (na === nb) return true;
  const pa = literalPrefix(na);
  const pb = literalPrefix(nb);
  if (!pa || !pb) return false;
  // one literal prefix is a string-prefix of the other glob
  return nb.startsWith(pa) || na.startsWith(pb);
}

/**
 * Find pairs of streams whose `owns` globs overlap. Disjoint ownership is
 * required so parallel streams never write the same files.
 */
export function findOwnsOverlaps(streams: { id: string; owns: string[] }[]): OwnsOverlap[] {
  const overlaps: OwnsOverlap[] = [];
  for (let i = 0; i < streams.length; i++) {
    for (let j = i + 1; j < streams.length; j++) {
      const a = streams[i];
      const b = streams[j];
      for (const ga of a.owns) {
        for (const gb of b.owns) {
          if (globsOverlap(ga, gb)) {
            overlaps.push({ streamA: a.id, streamB: b.id, globA: ga, globB: gb });
          }
        }
      }
    }
  }
  return overlaps;
}

// ── checkPlanContract ───────────────────────────────────────────────────────────

/**
 * Validate a plan's output artifacts against a blueprint contract. Fails closed:
 * every structural violation is a hard error; missing acceptance criteria surface
 * as a warning (the agent can still run, but blindly). Pass `DEFAULT_BLUEPRINT`
 * or a custom one derived from the active planning stages.
 */
export function checkPlanContract(
  artifacts: PlanArtifacts,
  blueprint: PlanBlueprint = DEFAULT_BLUEPRINT,
): ContractReport {
  const violations: ContractViolation[] = [];
  const warnings: ContractWarning[] = [];

  // 1. Stage gates: required sections present + non-placeholder + confirmed.
  for (const stage of blueprint.stages) {
    if (!stage.enabled) continue;

    const gaps = findPlanGaps(artifacts.sections, stage.requiredSections);
    for (const gap of gaps) {
      violations.push({
        code: `STAGE_SECTION_${gap.reason.toUpperCase()}`,
        message: `Stage "${stage.name}": required section "${gap.key}" is ${gap.reason}`,
      });
    }

    const confirmed = new Set(artifacts.confirmedSections);
    for (const key of stage.requiredConfirmed) {
      if (!confirmed.has(key)) {
        violations.push({
          code: "STAGE_SECTION_UNCONFIRMED",
          message: `Stage "${stage.name}": required section "${key}" has not been confirmed`,
        });
      }
    }
  }

  // 2. issues.json — agent-readiness.
  if (blueprint.requiresAgentReadyIssues && artifacts.issuesJson.trim()) {
    const issues = parseIssuesFile(artifacts.issuesJson);
    if (issues.length > 0) {
      const phases = parsePhases(artifacts.phasesJson);
      const phaseNames = phases.map((p) => p.name);
      const v = validateIssues(issues, phaseNames);

      for (const ref of v.duplicateRefs) {
        violations.push({ code: "ISSUES_DUPLICATE_REF", message: `issues.json: duplicate ref "${ref}"` });
      }
      for (const { ref, dependsOn } of v.danglingDependencies) {
        violations.push({ code: "ISSUES_DANGLING_DEP", message: `issues.json: "${ref}" depends on unknown ref "${dependsOn}"` });
      }
      for (const { ref, phase } of v.unknownPhases) {
        violations.push({ code: "ISSUES_UNKNOWN_PHASE", message: `issues.json: "${ref}" references unknown phase "${phase}"` });
      }
      for (const ref of v.missingAcceptance) {
        warnings.push({ code: "ISSUES_MISSING_ACCEPTANCE", message: `issues.json: "${ref}" has no acceptance criteria (not agent-ready)` });
      }
    }
  }

  // 3. fleet.json — stream owns disjoint.
  if (blueprint.requiresDisjointOwns && artifacts.fleetJson.trim()) {
    const fleet = parseFleetFile(artifacts.fleetJson);
    if (fleet && fleet.streams.length > 1) {
      const overlaps = findOwnsOverlaps(fleet.streams);
      for (const { streamA, streamB, globA, globB } of overlaps) {
        violations.push({
          code: "FLEET_OWNS_OVERLAP",
          message: `fleet.json: streams "${streamA}" and "${streamB}" have overlapping owns: "${globA}" ∩ "${globB}"`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}
