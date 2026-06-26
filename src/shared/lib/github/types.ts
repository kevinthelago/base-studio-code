// Shared GitHub data shapes (#1492, #1528) — reused across features (mcp, skills, planner,
// github). Genuinely-shared shapes live here; truly view-specific supersets (the full
// projectsV2 node in ProjectsList) stay with their feature.

/** A minimal GitHub Project reference (subset of the GraphQL `projectsV2` node). */
export interface GhProjectRef {
  id: string;
  number: number;
  title: string;
}

/** A GitHub REST milestone (the superset the Roadmap Gantt needs; ProjectsSummary reads a subset). */
export interface GhMilestone {
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  due_on: string | null;
  created_at: string;
  open_issues: number;
  closed_issues: number;
  creator: { login: string } | null;
}

/** A GitHub REST issue row (the `issues` endpoint also returns PRs — rows with `pull_request`
 *  set are PRs and must be excluded from "issues"). Union of the fields the fleet + portfolio
 *  views read. */
export interface GhIssueItem {
  number: number;
  title: string;
  state: string;
  created_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

/** A GitHub Events API event — the shape the user/repo activity feeds consume. */
export interface GHEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string };
  payload: unknown;
  created_at: string;
}

/** A GitHub issue/PR label — `name` + a 6-hex `color` (no leading `#`). */
export interface GhLabel {
  name: string;
  color: string;
}
