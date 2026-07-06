// Pure derivation for the Claude Config editor (#2128), extracted verbatim from ClaudeConfigCard.tsx.
// Kept React-free so it can be unit-tested in isolation.

import { projectRepoCwd } from "@/shared/lib/core/projectPaths";

/** A cloned repo the editor can target, with its local clone path. */
export interface RepoTarget {
  full_name: string;
  local_path: string;
}

/**
 * All unique cloned repos across all projects, with their local clone paths.
 * Repos live under `<base>/projects/<projectKey>/<repoShort>`, so the path is
 * derived from the project key each repo was cloned under. (Every hub lives under
 * the single `projects/` root since #922, so published-ness never affects the path
 * — the old alias-based published check is gone with the alias, #2409.)
 */
export function deriveAllRepos(
  projectLocalRepos: Record<string, string[]>,
  bscBaseDir: string,
): RepoTarget[] {
  const seen = new Map<string, string>(); // full_name → local_path (first seen wins)
  for (const [projectKey, fullNames] of Object.entries(projectLocalRepos)) {
    for (const fullName of fullNames) {
      if (!seen.has(fullName)) seen.set(fullName, projectRepoCwd(bscBaseDir, projectKey, fullName));
    }
  }
  return Array.from(seen.entries()).map(([fullName, local_path]) => ({
    full_name: fullName,
    local_path,
  }));
}
