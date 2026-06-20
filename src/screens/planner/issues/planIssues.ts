// Granular, agent-ready issues (#311). The planner decomposes each phase into
// self-contained issues, and each carries everything an agent needs to execute
// WITHOUT asking: a concrete title, acceptance criteria (the done-when), the
// files/dirs it owns, its dependencies, labels, and its milestone. These drive
// the GitHub-structure view and the publish flow (one real issue each), replacing
// the bare one-tracker-per-phase model.
//
// Written by the planner as `issues.json` (a JSON array) and via inline
// <plan_issue .../> tags. Pure (no React/Tauri) so it's unit-testable and shared
// by the parser, validator, structure builder, and publisher.

/** Execution-status lifecycle (#plan-db), mirrored from plan.db. A worker moves its issue
 *  open → in_progress → complete (pushed/PR'd); the director then checks CI and moves it
 *  complete → verified (green) or failed (red). `blocked` ⇒ waiting on an unmet dependency.
 *  Mirrors the Rust `STATUSES` in `crates/plandb`. */
export type PlanIssueStatus = "open" | "in_progress" | "blocked" | "complete" | "verified" | "failed";

export const PLAN_ISSUE_STATUSES: PlanIssueStatus[] = ["open", "in_progress", "blocked", "complete", "verified", "failed"];

/** One decomposed unit of work — becomes exactly one GitHub issue. */
export interface PlanIssue {
  /** Stable planner-local ref (e.g. "F1", "auth-login"). Used for dependsOn links
   *  and dedup; NOT the GitHub number (assigned at publish). */
  ref: string;
  /** Concrete, imperative title (e.g. "Add POST /sessions endpoint"). */
  title: string;
  /** Phase this issue belongs to — the 1-based phase number or its name. Resolved
   *  to a milestone at publish; undefined ⇒ unmilestoned (backlog). */
  phase?: number | string;
  /** Acceptance criteria — the done-when checklist an agent verifies against. */
  acceptance: string[];
  /** Files/dirs this issue owns, so the agent knows exactly where to work. */
  owns: string[];
  /** Refs of issues that must land before this one starts. */
  dependsOn: string[];
  /** Labels to apply (e.g. "scope:core", "area:api"). */
  labels: string[];
  /** Repo (owner/name) for a multi-repo project; undefined ⇒ the default repo. */
  repo?: string;
  /** Owning fleet stream id, if assigned (mirrors AgentStream.issues). */
  stream?: string;
  /** Ref of the parent feature this is a sub-issue of (#…). A feature is a parent issue; its
   *  decomposed work items carry the feature's ref here. Undefined ⇒ a top-level issue (a
   *  feature parent, or an unparented issue). Published as a GitHub sub-issue under its parent. */
  parent?: string;
  /** Extra prose/context beyond the acceptance list. */
  body?: string;
  /** Execution status from plan.db (#plan-db) — set by workers/director during the build.
   *  Absent on a freshly-planned issue (treated as "open"). */
  status?: PlanIssueStatus;
}

const toStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const toStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(toStr).filter(Boolean) : [];

/**
 * Parse the planner's `issues.json` (a JSON array of issue objects) into a clean
 * {@link PlanIssue}[]. Tolerant: bad JSON ⇒ `[]`; entries missing `ref` or `title`
 * are dropped (the minimum an issue needs to be addressable). `phase` accepts a
 * number or a name string. Mirrors {@link parseFleetFile}'s defensiveness.
 */
export function parseIssuesFile(raw: string): PlanIssue[] {
  if (!raw || !raw.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { issues?: unknown })?.issues) ? (data as { issues: unknown[] }).issues : [];
  const out: PlanIssue[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ref = toStr(o.ref) || toStr(o.id);
    const title = toStr(o.title);
    if (!ref || !title) continue;
    const phaseRaw = o.phase;
    const phase = typeof phaseRaw === "number" && Number.isFinite(phaseRaw)
      ? phaseRaw
      : (toStr(phaseRaw) || undefined);
    out.push({
      ref,
      title,
      phase,
      acceptance: toStrArray(o.acceptance),
      owns:       toStrArray(o.owns),
      dependsOn:  toStrArray(o.dependsOn ?? o.depends_on),
      labels:     toStrArray(o.labels),
      repo:       toStr(o.repo) || undefined,
      stream:     toStr(o.stream) || undefined,
      parent:     toStr(o.parent) || undefined,
      body:       toStr(o.body) || undefined,
      status:     (PLAN_ISSUE_STATUSES as string[]).includes(toStr(o.status)) ? (toStr(o.status) as PlanIssueStatus) : undefined,
    });
  }
  return out;
}

export interface IssueTreeNode {
  issue: PlanIssue;
  children: PlanIssue[];
}

/**
 * Group issues into the feature → sub-issue tree (#…). A root is an issue with no `parent`, or
 * whose `parent` doesn't resolve to another issue (orphans degrade to roots, never lost). Every
 * other issue nests under its parent's `ref`. Children keep their `issues.json` order.
 */
export function issueTree(issues: PlanIssue[]): IssueTreeNode[] {
  const byRef = new Map(issues.map((i) => [i.ref, i]));
  const roots: PlanIssue[] = [];
  const childrenOf = new Map<string, PlanIssue[]>();
  for (const i of issues) {
    if (i.parent && i.parent !== i.ref && byRef.has(i.parent)) {
      const list = childrenOf.get(i.parent) ?? [];
      list.push(i);
      childrenOf.set(i.parent, list);
    } else {
      roots.push(i);
    }
  }
  return roots.map((issue) => ({ issue, children: childrenOf.get(issue.ref) ?? [] }));
}

/**
 * The parent→child GitHub node-id pairs to link as sub-issues (#…), given the node ids known by
 * issue ref (created or pre-existing). Only pairs where BOTH ends resolve are returned — an
 * unresolved end (parent/child not created this run) is simply not linked. Self-parents skipped.
 */
export function subIssueLinks(
  issues: PlanIssue[],
  nodeByRef: Record<string, string>,
): { parent: string; child: string }[] {
  const out: { parent: string; child: string }[] = [];
  for (const i of issues) {
    if (!i.parent || i.parent === i.ref) continue;
    const child = nodeByRef[i.ref];
    const parent = nodeByRef[i.parent];
    if (child && parent) out.push({ parent, child });
  }
  return out;
}

export interface IssueValidation {
  ok: boolean;
  /** Refs used more than once (ambiguous dependency targets). */
  duplicateRefs: string[];
  /** `{ ref, dependsOn }` where the dependency ref doesn't exist. */
  danglingDependencies: { ref: string; dependsOn: string }[];
  /** Refs whose `phase` names/numbers no phase (when phaseNames is provided). */
  unknownPhases: { ref: string; phase: string | number }[];
  /** Issues with no acceptance criteria — not agent-ready (a warning, not fatal). */
  missingAcceptance: string[];
}

/**
 * Validate a decomposed issue set. `phaseNames` (in order) lets a `phase` reference
 * be checked: a number is 1-based into that list, a string must match a name. With
 * no `phaseNames`, phase checks are skipped. `ok` is true when there are no
 * duplicate refs, no dangling dependencies, and no unknown phases — the agent-ready
 * gate (missing acceptance is surfaced but doesn't fail validation).
 */
export function validateIssues(issues: PlanIssue[], phaseNames: string[] = []): IssueValidation {
  const seen = new Map<string, number>();
  for (const i of issues) seen.set(i.ref, (seen.get(i.ref) ?? 0) + 1);
  const duplicateRefs = [...seen.entries()].filter(([, n]) => n > 1).map(([r]) => r);

  const refs = new Set(issues.map((i) => i.ref));
  const danglingDependencies: { ref: string; dependsOn: string }[] = [];
  for (const i of issues) {
    for (const dep of i.dependsOn) {
      if (!refs.has(dep)) danglingDependencies.push({ ref: i.ref, dependsOn: dep });
    }
  }

  const unknownPhases: { ref: string; phase: string | number }[] = [];
  if (phaseNames.length > 0) {
    for (const i of issues) {
      if (i.phase === undefined) continue;
      const known = typeof i.phase === "number"
        ? i.phase >= 1 && i.phase <= phaseNames.length
        : phaseNames.filter((n) => phaseTagMatches(n, String(i.phase))).length === 1;
      if (!known) unknownPhases.push({ ref: i.ref, phase: i.phase });
    }
  }

  const missingAcceptance = issues.filter((i) => i.acceptance.length === 0).map((i) => i.ref);

  return {
    ok: duplicateRefs.length === 0 && danglingDependencies.length === 0 && unknownPhases.length === 0,
    duplicateRefs,
    danglingDependencies,
    unknownPhases,
    missingAcceptance,
  };
}

/**
 * Resolve a {@link PlanIssue.phase} (1-based number or a phase name) to a 0-based
 * index into `phaseNames` — the milestone the issue pins to at publish. Returns
 * undefined for an absent or unmatched phase (the issue lands unmilestoned). Name
 * matching is case-insensitive, mirroring {@link validateIssues}.
 */
/**
 * True when a phase  from  matches a planner-supplied . Accepts:
 * - exact or case-insensitive full-name match
 * - boundary-anchored version-prefix: name starts with tag + " " (e.g. "0.9.7" matches
 *   "0.9.7 - Finish line: …" without matching "0.9.71 - …").
 * The same predicate is used by both {@link resolvePhaseIndex} and {@link validateIssues}
 * so the gate and resolver never disagree (#550).
 */
export function phaseTagMatches(name: string, tag: string): boolean {
  const lo = name.toLowerCase();
  const t = tag.toLowerCase();
  return name === tag || lo === t || lo.startsWith(t + " ");
}

export function resolvePhaseIndex(phase: number | string | undefined, phaseNames: string[]): number | undefined {
  if (phase === undefined) return undefined;
  if (typeof phase === "number") return phase >= 1 && phase <= phaseNames.length ? phase - 1 : undefined;
  const tag = String(phase);
  const spaceMatches = phaseNames.reduce<number[]>((acc, n, i) => phaseTagMatches(n, tag) ? [...acc, i] : acc, []);
  if (spaceMatches.length === 1) return spaceMatches[0];
  if (spaceMatches.length > 1) return undefined;
  // Dot-delimited fallback: "1.0" matches "1.0.0 - GA" when no space-prefix match exists
  const t = tag.toLowerCase();
  const dotMatches = phaseNames.reduce<number[]>(
    (acc, n, i) => n.toLowerCase().startsWith(t + ".") ? [...acc, i] : acc, []
  );
  if (dotMatches.length === 1) return dotMatches[0];
  return undefined;
}

/**
 * Render a {@link PlanIssue} as a GitHub issue body — the agent-facing contract:
 * the acceptance checklist, the owned paths, and the dependency list, so whoever
 * picks it up has everything without re-deriving it from the plan.
 */
export function renderIssueBody(issue: PlanIssue): string {
  const parts: string[] = [];
  if (issue.body) parts.push(issue.body.trim());
  if (issue.acceptance.length) {
    parts.push("## Acceptance criteria\n" + issue.acceptance.map((a) => `- [ ] ${a}`).join("\n"));
  }
  if (issue.owns.length) {
    parts.push("## Owns\n" + issue.owns.map((o) => `- \`${o}\``).join("\n"));
  }
  if (issue.dependsOn.length) {
    parts.push("## Depends on\n" + issue.dependsOn.map((d) => `- ${d}`).join("\n"));
  }
  parts.push("---\n_Auto-generated by the base-studio-code planner._");
  // Hidden ref marker (#plan-db) — see {@link refMarker}.
  parts.push(refMarker(issue.ref));
  return parts.join("\n\n");
}

/**
 * The hidden HTML-comment marker that carries an issue's planner-local `ref` through a publish.
 * Invisible in GitHub's rendered issue view, but present in the raw body — so the GitHub→plan.db
 * recovery path can reconstruct the ref (and therefore the `dependsOn` links, which reference
 * planner refs), which GitHub doesn't persist natively. The single enabler for lossless recovery.
 */
export function refMarker(ref: string): string {
  return `<!-- bsc:ref=${ref} -->`;
}

/** Extract the planner-local ref from a published issue body's {@link refMarker}, or undefined. */
export function parseRefMarker(body: string): string | undefined {
  const m = /<!--\s*bsc:ref=([^\s>]+)\s*-->/.exec(body ?? "");
  return m ? m[1].trim() : undefined;
}
