// Deterministic agent-readiness grading for the plan's executable core (#445):
// repos, milestones, and issues. Pure (no React / Tauri) so it is instantly
// unit-testable from existing plan data (issues.json, phases.json, fleet.json,
// linked repos) — no LLM or async I/O. Advisory only: the caller shows the grade
// and may prompt a soft confirm below a threshold, but never hard-blocks.

import type { PlanIssue } from "../screens/planner/issues/planIssues";

// ── Letter grade ─────────────────────────────────────────────────────────────

export type Letter = "A" | "B" | "C" | "D" | "F";

export function letterFromScore(score: number): Letter {
  if (score >= 0.90) return "A";
  if (score >= 0.75) return "B";
  if (score >= 0.60) return "C";
  if (score >= 0.45) return "D";
  return "F";
}

/** The ONE grade color map — keyed by letter so chips and bars always agree (#686).
 *  Every grade color in the app should derive from this (via {@link gradeColor}). */
export function letterColor(letter: Letter): string {
  switch (letter) {
    case "A": return "var(--success)";
    case "B": return "var(--accent)";
    case "C": return "oklch(0.74 0.14 90)";
    case "D": return "oklch(0.72 0.15 55)";
    default:  return "var(--danger)";
  }
}

/** Color for a 0..1 score, routed through the letter tiers so a bar's color always
 *  matches its letter grade (#686). Pass `n / 100` for a 0..100 score. */
export function gradeColor(score: number): string {
  return letterColor(letterFromScore(score));
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
  score:        number;
  letter:       Letter;
  reasons:      string[];
  repoGrades:   RepoGrade[];
  /** Plan-wide rubric breakdown, one row per dimension (renderable report). */
  categories:   CategoryGrade[];
  /** Prioritized, actionable fixes derived from the weakest categories. */
  suggestions:  Suggestion[];
}

// ── Category breakdown + suggestions (the renderable report) ────────────────────

export type Priority = "high" | "medium" | "low";

/** One rubric dimension rolled up across every issue — the report's score rows. */
export interface CategoryGrade {
  id:        string;
  label:     string;
  /** Fraction of issues (or milestones, for granularity) that satisfy this dimension. */
  score:     number;
  letter:    Letter;
  /** Weight in the per-issue rubric (0 for the milestone-shaped granularity row). */
  weight:    number;
  /** Human reasoning, e.g. "12/18 issues define ≥2 acceptance criteria". */
  detail:    string;
  /** Up to a few issue refs (or milestone names) that fall short. */
  examples:  string[];
}

/** An actionable recommendation surfaced from a category that scored below 100%. */
export interface Suggestion {
  priority:  Priority;
  /** The CategoryGrade.id this came from. */
  category:  string;
  title:     string;
  detail:    string;
}

interface Dimension {
  id:     string;
  label:  string;
  weight: number;
  ok:     (i: PlanIssue) => boolean;
  /** Satisfied-phrasing for the detail line ("define ≥2 acceptance criteria"). */
  good:   string;
  /** Imperative remedy for the suggestion title ("add ≥2 acceptance criteria"). */
  fix:    string;
  /** Why it matters — the suggestion's detail line. */
  why:    string;
}

// Mirrors the per-issue rubric weights in gradeIssue so the breakdown is faithful.
const DIMENSIONS: Dimension[] = [
  { id: "acceptance", label: "Acceptance criteria", weight: 0.35, ok: i => i.acceptance.length >= 2,
    good: "define ≥2 acceptance criteria", fix: "add ≥2 acceptance criteria",
    why: "Acceptance criteria are the done-when contract — without them an agent can't tell when it's finished." },
  { id: "ownership", label: "File ownership", weight: 0.20, ok: i => i.owns.length > 0,
    good: "declare owned files/globs", fix: "declare the files or globs they own",
    why: "Owned globs are the boundary the agent works within, so parallel streams don't collide." },
  { id: "milestones", label: "Milestone assignment", weight: 0.20, ok: i => i.phase !== undefined,
    good: "are assigned to a milestone", fix: "assign a milestone/phase",
    why: "An unscheduled issue lands nowhere on the roadmap and never publishes under a milestone." },
  { id: "streams", label: "Stream ownership", weight: 0.15, ok: i => !!i.stream,
    good: "name an owning stream", fix: "name an owning stream",
    why: "Without an owning stream there's coordination ambiguity over which agent picks it up." },
  { id: "titles", label: "Title clarity", weight: 0.10, ok: i => i.title.trim().length >= 10,
    good: "have a descriptive title", fix: "give a descriptive (≥10 char) title",
    why: "A one-word title is too vague for an agent to act on without re-reading the whole issue." },
];

function priorityFor(impact: number): Priority {
  if (impact >= 0.12) return "high";
  if (impact >= 0.05) return "medium";
  return "low";
}

/** Roll each rubric dimension up across all issues, plus a milestone-granularity row. */
function buildCategories(issues: PlanIssue[], repoGrades: RepoGrade[]): CategoryGrade[] {
  const n = issues.length;
  const cats: CategoryGrade[] = DIMENSIONS.map(d => {
    const fails  = issues.filter(i => !d.ok(i));
    const passed = n - fails.length;
    const score  = n > 0 ? passed / n : 0;
    return {
      id: d.id, label: d.label, score, letter: letterFromScore(score), weight: d.weight,
      detail: `${passed}/${n} issues ${d.good}`,
      examples: fails.slice(0, 4).map(i => i.ref),
    };
  });

  // Granularity is milestone-shaped, not issue-shaped: score by the share of
  // milestones sized within [MIN, MAX] issues.
  const milestones = repoGrades.flatMap(r => r.milestoneGrades).filter(m => m.issueGrades.length > 0);
  const sized   = (m: MilestoneGrade) => m.issueGrades.length >= MILESTONE_MIN_ISSUES && m.issueGrades.length <= MILESTONE_MAX_ISSUES;
  const wellSized = milestones.filter(sized);
  const offSize   = milestones.filter(m => !sized(m));
  const granScore = milestones.length > 0 ? wellSized.length / milestones.length : 0;
  cats.push({
    id: "granularity", label: "Milestone granularity", score: granScore, letter: letterFromScore(granScore), weight: 0,
    detail: milestones.length > 0
      ? `${wellSized.length}/${milestones.length} milestones sized ${MILESTONE_MIN_ISSUES}–${MILESTONE_MAX_ISSUES} issues`
      : "no milestones resolved",
    examples: offSize.slice(0, 4).map(m => `${m.name} (${m.issueGrades.length})`),
  });
  return cats;
}

/** Turn every below-100% category into a prioritized, example-bearing suggestion. */
function buildSuggestions(categories: CategoryGrade[], issueCount: number): Suggestion[] {
  const byId = new Map(DIMENSIONS.map(d => [d.id, d]));
  const out: Suggestion[] = categories.flatMap(c => {
    if (c.score >= 0.999) return [];
    const shortfall = 1 - c.score;
    const impact    = (c.weight || 0.10) * shortfall;
    const ex        = c.examples.length > 0 ? ` (e.g. ${c.examples.join(", ")})` : "";

    if (c.id === "granularity") {
      const k = c.examples.length;
      return [{
        priority: priorityFor(impact), category: c.id,
        title: `Re-scope ${k} milestone${k === 1 ? "" : "s"} toward ${MILESTONE_MIN_ISSUES}–${MILESTONE_MAX_ISSUES} issues`,
        detail: `Milestones outside that range read as under- or over-scoped.${ex}`,
      }];
    }

    const d = byId.get(c.id);
    const k = Math.round(shortfall * issueCount);
    return [{
      priority: priorityFor(impact), category: c.id,
      title: `${k} issue${k === 1 ? "" : "s"}: ${d?.fix ?? "improve this dimension"}`,
      detail: `${d?.why ?? ""}${ex}`,
    }];
  });
  const rank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
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
    return { score: 0, letter: "F", reasons: ["no issues defined"], repoGrades: [], categories: [], suggestions: [] };
  }
  if (repos.length === 0) {
    return { score: 0, letter: "F", reasons: ["no repos linked"], repoGrades: [], categories: [], suggestions: [] };
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
  const categories  = buildCategories(normalised, repoGrades);
  const suggestions = buildSuggestions(categories, normalised.length);
  return { score, letter: letterFromScore(score), reasons, repoGrades, categories, suggestions };
}
