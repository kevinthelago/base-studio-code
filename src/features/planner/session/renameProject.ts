// Rename a PUBLISHED project (#1226) — the pure decision + the apply step, extracted from
// Planning.tsx so the guard + the GitHub-board update are unit-testable. Renaming updates the
// board title + the local display name but KEEPS the frozen session key / on-disk folder (#2409:
// renames are display-only — the folder keeps its birth-slug; reopening under the new name goes
// through the reopen-mismatch modal, which can do the real on-disk move).

import { projectSlug } from "@/shared/lib/core/projectPaths";

/** Update a published GitHub Project (V2) board title; leaves milestones/issues untouched. */
export const RENAME_PROJECT_MUTATION = `
  mutation RenameProject($projectId: ID!, $title: String!) {
    updateProjectV2(input: { projectId: $projectId, title: $title }) {
      projectV2 { id title }
    }
  }
`;

export type RenamePlan =
  | { kind: "noop" }
  | { kind: "error"; message: string }
  | { kind: "rename"; title: string };

/**
 * Decide what a rename commit should do, given the raw input, the current name + project id, and
 * the OTHER projects' frozen keys (for the duplicate guard). Trimmed empty / unchanged / no-id all
 * no-op; a name that slugifies onto another project's key is an error; otherwise rename.
 */
export function planRename(
  raw: string,
  currentName: string,
  projectId: string | null,
  otherKeys: ReadonlySet<string>,
): RenamePlan {
  const next = raw.trim();
  if (!next || next === currentName || !projectId) return { kind: "noop" };
  // Keys are name-derived slugs (#2409): a rename whose slug lands on another project's key would
  // make the two names resolve to ONE hub at reopen — block it here.
  if (otherKeys.has(projectSlug(next))) {
    return { kind: "error", message: "Another project already uses that name." };
  }
  return { kind: "rename", title: next };
}

export interface RenameDeps {
  /** The GitHub GraphQL bridge (injected for tests). */
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
  /** Update local project meta (name/repo/number/repos). */
  setMeta: (id: string, name: string, repo: string, number: number, repos: string[]) => void;
  repo: string;
  number: number;
  repos: string[];
}

/**
 * Apply a planned rename: update LOCAL state first (graceful — the planner reflects the rename even
 * if GitHub is unreachable, mirroring how delete removes locally on a GitHub failure), then push the
 * board title. Returns an error message when the GitHub update failed (local is already updated and
 * the rename is retryable), else `null`.
 */
export async function applyRename(projectId: string, title: string, deps: RenameDeps): Promise<string | null> {
  deps.setMeta(projectId, title, deps.repo, deps.number, deps.repos);
  try {
    await deps.graphql(RENAME_PROJECT_MUTATION, { projectId, title });
    return null;
  } catch {
    return "Renamed locally; the GitHub board update failed — edit again to retry.";
  }
}
