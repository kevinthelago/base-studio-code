// projectPaneStructure -- maps decomposed plan issues (+ the live GitHub progress
// overlay) into the ProjectPane repo-first `Milestone` structure. Extracted from
// projectPaneData (#2151); pure, no logic changes.

import type { PlanIssue } from "../issues/planIssues";
import type { Issue, Milestone } from "./projectPane.types";
import type { BuildProjectPaneInput } from "./projectPaneInput";

/** Shared issue derivation for the repo-first structure builder: how an issue
 *  attributes to a repo, whether it's closed (live overlay → static label
 *  fallback), the render shape, and a closed-fraction helper. */
function issueHelpers(input: BuildProjectPaneInput) {
  const { repos, progress } = input;
  const firstAgent = input.fleet?.streams[0]?.id ?? "";
  // Attribute each issue to a repo: its explicit `repo`, else the first publish repo.
  const fallbackRepo = repos[0] ?? "";
  const repoOf = (p: PlanIssue): string => p.repo || fallbackRepo;

  // An issue is done when the live GitHub overlay (#393 Layer 2) marks its
  // structure node closed, falling back to a static done/closed label on the plan
  // issue (#429). The node id mirrors buildGhStructure: `issue:{repo}:{ref}`.
  const staticClosed = (p: PlanIssue): boolean =>
    p.labels.some(l => /^(done|closed)$/i.test(l));
  const issueClosed = (p: PlanIssue): boolean =>
    progress?.[`issue:${repoOf(p)}:${p.ref}`]?.done ?? staticClosed(p);
  const toIssue = (p: PlanIssue): Issue => ({
    n: p.ref,
    t: p.title,
    state: issueClosed(p) ? "done" : "backlog",
    owner: p.stream || firstAgent || "",
    ac: p.acceptance.length,
    branch: p.ref,
    deps: p.dependsOn,
    // Acceptance sub-items: when the live overlay marks the issue closed, treat
    // every acceptance criterion as met so the drill-in checklist agrees with the
    // issue's done state; otherwise leave them open (the overlay tracks per-issue,
    // not per-criterion, state).
    sub: p.acceptance.map(a => ({ t: a, done: issueClosed(p) })),
    repo: repoOf(p),
  });
  const pct = (group: PlanIssue[]): number =>
    group.length ? group.filter(issueClosed).length / group.length : 0;
  return { repoOf, issueClosed, toIssue, pct };
}

/**
 * Repo-first structure (#497, #1912): one milestone per repo carrying every issue
 * that attributes to it (its `repo`, or the default repo when unset), with a single
 * closed/total/pct rollup. Milestone phases were removed (#1912), so issues are no
 * longer grouped by roadmap phase — just by repo.
 */
export function buildStructure(input: BuildProjectPaneInput): Milestone[] {
  const { issues, repos } = input;
  if (issues.length === 0) return [];
  const { repoOf, toIssue, pct } = issueHelpers(input);

  const repoOrder: string[] = [...repos];
  for (const p of issues) {
    const r = repoOf(p);
    if (!repoOrder.includes(r)) repoOrder.push(r);
  }

  const out: Milestone[] = [];
  for (const repo of repoOrder) {
    const repoIssues = issues.filter(p => repoOf(p) === repo);
    if (repoIssues.length === 0) continue;
    const fraction = pct(repoIssues);
    out.push({
      id: `${repo}#M1`,
      title: "Issues",
      repo,
      pct: fraction,
      state: "doing",
      epics: [{ id: `${repo}#E1`, title: "Issues", pct: fraction, issues: repoIssues.map(toIssue) }],
    });
  }
  return out;
}
