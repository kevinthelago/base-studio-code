import { invoke } from "@tauri-apps/api/core";

/** Minimal shape of a ProjectV2 item needed to resolve its repository. */
export interface ProjectItemNode {
  content?: { repository?: { nameWithOwner?: string } | null } | null;
}

/**
 * Unique `owner/name` repositories referenced by a project's items.
 *
 * Repos are derived from the issues on the project board rather than the
 * project-level `repositories` field: that field only reflects repos a user has
 * explicitly linked in the GitHub UI and is therefore frequently incomplete,
 * whereas every issue carries the repository it lives in.
 */
export function reposFromItems(nodes: ReadonlyArray<ProjectItemNode>): string[] {
  return [...new Set(
    nodes
      .map(n => n.content?.repository?.nameWithOwner)
      .filter((r): r is string => !!r),
  )];
}

// Lightweight query — only the fields needed to resolve repos, so the tab-open
// scan stays cheap even when the heavier board view isn't mounted.
const PROJECT_REPOS_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes { content { ... on Issue { repository { nameWithOwner } } } }
      }
    }
  }
}`;

interface ReposQueryResult {
  node?: { items?: { nodes?: ProjectItemNode[] } } | null;
}

/**
 * Resolves the full set of repositories linked to a GitHub Project by scanning
 * its items. Returns `owner/name` strings (empty if the project has no issues).
 *
 * @param token - GitHub token for the GraphQL request.
 * @param projectId - ProjectV2 node id.
 */
export async function scanProjectRepos(token: string, projectId: string): Promise<string[]> {
  const data = await invoke<ReposQueryResult>("github_graphql", {
    token, query: PROJECT_REPOS_QUERY, variables: { id: projectId },
  });
  return reposFromItems(data.node?.items?.nodes ?? []);
}

/**
 * Reads the on-disk plan sections for a project (the markdown the planner's
 * Claude session writes), keyed by section name. Mirrors the planner's own poll
 * so the plan can be refreshed without entering the planner.
 *
 * @param projectKey - the planning session key (the project title for projects
 *   opened from the list), matching the directory where plan files are stored.
 */
export async function scanPlanStages(projectKey: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("read_plan_stages", { projectKey });
}
