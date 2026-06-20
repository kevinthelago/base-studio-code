// Live issue-progression overlay (#393, Layer 2). Where buildGhStructure derives
// the *plan* (what GitHub objects this plan produces), this module derives the
// *progress*: for an already-published project it maps each structure node id to
// a NodeProgress reflecting what's actually CLOSED/done on GitHub.
//
// Pure - no React / Tauri / network. The caller fetches per-repo issue + milestone
// state and hands it here; this builds a deterministic id -> NodeProgress overlay
// the structure card renders (done checkmarks, per-milestone progress bars, an
// overall rollup). Kept I/O-free so it can be unit tested in isolation.

import type { GhStructure } from "./ghStructure";

/** One GitHub issue's live state, normalized from the REST `issues` payload. */
export interface IssueState {
  title: string;
  state: "open" | "closed";
  number: number;
  url: string;
  /** Milestone title the issue is pinned to, or null when unmilestoned. */
  milestone: string | null;
}

/** One GitHub milestone's open/closed issue counts, from the REST `milestones` payload. */
export interface MilestoneState {
  title: string;
  open: number;
  closed: number;
}

/**
 * Progress for a single structure node.
 * - Issue nodes: `done` (closed), plus `url`/`number` for linking.
 * - Rollup nodes (milestone/repo/project): `closed`/`total` counts; `done` when complete.
 */
export interface NodeProgress {
  done?: boolean;
  closed?: number;
  total?: number;
  url?: string;
  number?: number;
}

/** Case-insensitive, whitespace-trimmed key for matching an issue node label to a GitHub title. */
const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Build the live-progression overlay: a structure-node id -> {@link NodeProgress}
 * map, derived from per-repo GitHub issue and milestone state. Pure and
 * deterministic.
 *
 * - **Issue nodes** (`issue:{repo}:{ref}`): matched to a GitHub issue by its
 *   persisted link (#393 Layer 1) — node id -> exact issue NUMBER — falling back
 *   to case-insensitive/trimmed title equality within the same repo. A match
 *   yields `{ done: state==="closed", url, number }`. Legacy phase-tracker nodes
 *   (label `[phase] title`) won't equal a real issue title and are simply left
 *   with no progress - that's acceptable.
 * - **Milestone nodes** (`ms:{i}`): open/closed summed across ALL repos for the
 *   milestone whose title equals `structure.milestones[i].label`. Yields
 *   `{ closed, total, done: total>0 && open===0 }`.
 * - **Repo nodes** (`repo:{fullName}`): rolled up from that repo's matched issue
 *   nodes -> `{ closed, total }` (total = matched issue nodes only).
 * - **Project node** (`project`): rolled up across all matched issues.
 * - **Stream nodes**: skipped - no reliable mapping without #393 Layer 1.
 *
 * @param structure        the derived GitHub object graph (node ids + labels)
 * @param issuesByRepo     full_name -> its GitHub issues (PRs already filtered out)
 * @param milestonesByRepo full_name -> its GitHub milestones with open/closed counts
 * @param links            optional node id -> linked GitHub issue ({number,url}); when
 *                         present, an issue node is matched to that exact issue number
 *                         (robust to title drift) before falling back to title match.
 * @returns node id -> progress; nodes with no progress are simply absent.
 */
export function buildProgressOverlay(
  structure: GhStructure,
  issuesByRepo: Record<string, IssueState[]>,
  milestonesByRepo: Record<string, MilestoneState[]>,
  links?: Record<string, { number: number; url: string }>,   // nodeId -> linked GitHub issue
): Record<string, NodeProgress> {
  const overlay: Record<string, NodeProgress> = {};

  // Running tallies for the project rollup, across every repo's matched issues.
  let projClosed = 0;
  let projTotal = 0;

  // -- Issue + repo nodes ------------------------------------------------------
  for (const repo of structure.repos) {
    const fullName = repo.node.label;
    const issues = issuesByRepo[fullName] ?? [];
    // Index this repo's GitHub issues by normalized title for O(1) matching.
    // Last write wins on duplicate titles - fine; titles are effectively unique.
    const byTitle = new Map<string, IssueState>();
    for (const iss of issues) byTitle.set(norm(iss.title), iss);
    // Index by issue number too, so a persisted link (#393 Layer 1) matches the
    // exact GitHub issue regardless of title drift.
    const byNumber = new Map<number, IssueState>();
    for (const iss of issues) byNumber.set(iss.number, iss);

    let repoClosed = 0;
    let repoTotal = 0;

    for (const node of repo.issues) {
      // Robust path: a persisted link pins this node to a real GitHub issue
      // number; match by number first, then fall back to title equality.
      const linked = links?.[node.id];
      const match = (linked && byNumber.get(linked.number)) ?? byTitle.get(norm(node.label));
      if (!match) continue; // unmatched (e.g. legacy phase-tracker node) -> no progress
      const done = match.state === "closed";
      overlay[node.id] = { done, url: match.url, number: match.number };
      repoTotal++;
      projTotal++;
      if (done) {
        repoClosed++;
        projClosed++;
      }
    }

    if (repoTotal > 0) {
      overlay[repo.node.id] = { closed: repoClosed, total: repoTotal };
    }
  }

  // -- Milestone nodes ---------------------------------------------------------
  structure.milestones.forEach((ms, i) => {
    let open = 0;
    let closed = 0;
    let seen = false;
    for (const list of Object.values(milestonesByRepo)) {
      for (const m of list) {
        if (norm(m.title) === norm(ms.label)) {
          open += m.open;
          closed += m.closed;
          seen = true;
        }
      }
    }
    if (!seen) return; // milestone not present on any repo yet -> no progress
    const total = open + closed;
    overlay[`ms:${i}`] = { closed, total, done: total > 0 && open === 0 };
  });

  // -- Project node ------------------------------------------------------------
  if (projTotal > 0) {
    overlay.project = { closed: projClosed, total: projTotal };
  }

  return overlay;
}
