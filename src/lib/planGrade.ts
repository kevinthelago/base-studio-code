// Deterministic agent-readiness grading for the plan's executable core (#445):
// repos, milestones, and issues. Pure (no React / Tauri) so it is instantly
// unit-testable from existing plan data (issues.json, phases.json, fleet.json,
// linked repos) — no LLM or async I/O. Advisory only: the caller shows the grade
// and may prompt a soft confirm below a threshold, but never hard-blocks.

import type { PlanIssue } from "../screens/projects/planIssues";

// ── Letter grade ─────────────────────────────────────────────────────────────

export type Letter = "A" | "B" | "C" | "D" | "F";

export function letterFromScore(score: number): Letter {
  if (score >= 0.90) return "A";
  if (score >= 0.75) return "B";
  if (score >= 0.60) return "C";
  if (score >= 0.45) return "D";
  return "F";
}

// ── Issue grade ───────────────────────────────────────────────────────────────

export interface IssueGrade {
  ref:     string;
  score:   number;
  letter:  Letter;
  /** Per-dimension shortfalls, empty when none. */
  reasons: string[];
}

/**
 * Grade one issue against the agent-readiness rubric. The rubric is intentionally
 * deterministic and shallow — semantic depth is a future LLM audit pass.
 *
 * Weights (must sum to 1.0):
 *   acceptance ≥2  0.35  — the done-when contract (highest: a single criterion is
 *                           weaker than a real checklist)
 *   owns           0.20  — the file boundary so the agent knows where to work
 *   phase          0.20  — milestone assignment so it lands somewhere
 *   stream         0.15  — owning agent so no coordination ambiguity
 *   title length   0.10  — a one-word title is too vague
 */
export function gradeIssue(issue: PlanIssue): IssueGrade {
  let score = 0;
  const reasons: string[] = [];

  const acCount = issue.acceptance.length;
  if (acCount >= 2) {
    score += 0.35;
  } else if (acCount === 1) {
    score += 0.18; // partial credit: one criterion is thin but better than none
    reasons.push("only 1 acceptance criterion (aim for ≥2)");
  } else {
    reasons.push("no acceptance criteria");
  }

  if (issue.owns.length > 0) {
    score += 0.20;
  } else {
    reasons.push("no owned files/globs declared");
  }

  if (issue.phase !== undefined) {
    score += 0.20;
  } else {
    reasons.push("not assigned to a milestone/phase");
  }

  if (issue.stream) {
    score += 0.15;
  } else {
    reasons.push("no owning stream");
  }

  if (issue.title.trim().length >= 10) {
    score += 0.10;
  } else {
    reasons.push("title too short");
  }

  const clamped = Math.min(1, Math.max(0, score));
  return { ref: issue.ref, score: clamped, letter: letterFromScore(clamped), reasons };
}

// ── Milestone grade ───────────────────────────────────────────────────────────

export interface MilestoneGrade {
  name:         string;
  score:        number;
  letter:       Letter;
  reasons:      string[];
  issueGrades:  IssueGrade[];
}

const MILESTONE_MIN_ISSUES = 2;
const MILESTONE_MAX_ISSUES = 15;

/**
 * Grade a milestone (a named phase + its issues). An empty milestone earns 0.
 * Granularity penalty applies outside [2, 15] issues — too few is underscoped,
 * too many suggests missing decomposition.
 */
export function gradeMilestone(name: string, issues: PlanIssue[]): MilestoneGrade {
  const reasons: string[] = [];

  if (issues.length === 0) {
    return { name, score: 0, letter: "F", reasons: ["no issues in this milestone"], issueGrades: [] };
  }

  const issueGrades = issues.map(gradeIssue);
  const avgIssue = issueGrades.reduce((sum, g) => sum + g.score, 0) / issueGrades.length;

  let granularityBonus = 1.0;
  if (issues.length < MILESTONE_MIN_ISSUES) {
    granularityBonus = 0.75;
    reasons.push(`only ${issues.length} issue — too few; consider decomposing further`);
  } else if (issues.length > MILESTONE_MAX_ISSUES) {
    granularityBonus = 0.85;
    reasons.push(`${issues.length} issues — unusually many; consider splitting the milestone`);
  }

  const score = Math.min(1, avgIssue * granularityBonus);
  return { name, score, letter: letterFromScore(score), reasons, issueGrades };
}

// ── Repo grade ────────────────────────────────────────────────────────────────

export interface RepoGrade {
  repo:             string;
  score:            number;
  letter:           Letter;
  reasons:          string[];
  milestoneGrades:  MilestoneGrade[];
}

/**
 * Grade a linked repo: rolls up its milestone grades weighted by issue count.
 * A repo with no attributed work earns 0.
 */
export function gradeRepo(
  repo: string,
  issues: PlanIssue[],
  phases: { name: string }[],
): RepoGrade {
  const reasons: string[] = [];

  const repoIssues = issues.filter(i => (i.repo ?? "") === repo || (issues.every(ii => !ii.repo) && issues.length > 0));
  if (repoIssues.length === 0) {
    return { repo, score: 0, letter: "F", reasons: ["no issues attributed to this repo"], milestoneGrades: [] };
  }

  // Group by phase; unscheduled issues get their own group.
  const phaseNames = phases.map(p => p.name);
  const byPhase = new Map<string, PlanIssue[]>();
  const unscheduled: PlanIssue[] = [];
  for (const i of repoIssues) {
    if (i.phase === undefined) { unscheduled.push(i); continue; }
    const key = String(i.phase);
    const grp = byPhase.get(key) ?? [];
    grp.push(i);
    byPhase.set(key, grp);
  }

  const milestoneGrades: MilestoneGrade[] = [];
  for (const ph of phaseNames) {
    const grp = byPhase.get(ph) ?? byPhase.get(String(phaseNames.indexOf(ph) + 1)) ?? [];
    if (grp.length > 0) milestoneGrades.push(gradeMilestone(ph, grp));
  }
  if (unscheduled.length > 0) {
    const mg = gradeMilestone("Unscheduled", unscheduled);
    reasons.push(`${unscheduled.length} unscheduled issue${unscheduled.length > 1 ? "s" : ""}`);
    milestoneGrades.push(mg);
  }

  if (milestoneGrades.length === 0) {
    return { repo, score: 0, letter: "F", reasons: ["no milestones resolved for this repo"], milestoneGrades };
  }

  const totalIssues = milestoneGrades.reduce((sum, mg) => sum + mg.issueGrades.length, 0);
  const weightedScore = totalIssues > 0
    ? milestoneGrades.reduce((sum, mg) => sum + mg.score * mg.issueGrades.length, 0) / totalIssues
    : 0;

  const score = Math.min(1, weightedScore);
  return { repo, score, letter: letterFromScore(score), reasons, milestoneGrades };
}

// ── Overall plan grade ────────────────────────────────────────────────────────

export interface PlanGrade {
  score:       number;
  letter:      Letter;
  reasons:     string[];
  repoGrades:  RepoGrade[];
}

/**
 * Grade the whole plan: rolls up repo grades weighted by issue count. An empty
 * plan earns 0. The `repos` list is the set of linked repo full names; issues
 * whose `repo` field is absent are attributed to the first repo.
 */
export function gradePlan(
  issues: PlanIssue[],
  phases: { name: string }[],
  repos: string[],
): PlanGrade {
  const reasons: string[] = [];

  if (issues.length === 0) {
    return { score: 0, letter: "F", reasons: ["no issues defined"], repoGrades: [] };
  }
  if (repos.length === 0) {
    return { score: 0, letter: "F", reasons: ["no repos linked"], repoGrades: [] };
  }

  const fallback = repos[0];
  // Normalise: blank repo → fallback
  const normalised = issues.map(i => ({ ...i, repo: i.repo || fallback }));

  const repoGrades = repos.map(r => gradeRepo(r, normalised.filter(i => i.repo === r), phases));

  // Warn about issues pointing at unlisted repos.
  const linkedSet = new Set(repos);
  const orphans = normalised.filter(i => i.repo && !linkedSet.has(i.repo));
  if (orphans.length > 0) {
    reasons.push(`${orphans.length} issue${orphans.length > 1 ? "s" : ""} reference an unlinked repo`);
  }

  const totalIssues = repoGrades.reduce((sum, rg) => sum + rg.milestoneGrades.reduce((s2, mg) => s2 + mg.issueGrades.length, 0), 0);
  const weightedScore = totalIssues > 0
    ? repoGrades.reduce((sum, rg) => {
        const cnt = rg.milestoneGrades.reduce((s2, mg) => s2 + mg.issueGrades.length, 0);
        return sum + rg.score * cnt;
      }, 0) / totalIssues
    : 0;

  const score = Math.min(1, weightedScore);
  return { score, letter: letterFromScore(score), reasons, repoGrades };
}
