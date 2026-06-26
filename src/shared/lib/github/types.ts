// Shared GitHub data shapes (#1492) — reused across features (mcp, skills, planner,
// github). Only the genuinely-identical shapes live here; view-specific supersets
// (the full projectsV2 node in ProjectsList, the REST/GraphQL milestone variants) stay
// with their feature.

/** A minimal GitHub Project reference (subset of the GraphQL `projectsV2` node). */
export interface GhProjectRef {
  id: string;
  number: number;
  title: string;
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
