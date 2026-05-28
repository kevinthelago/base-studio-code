// Path helpers for the app-managed base directory (`~/.base-studio-code`).
//
// Repositories are cloned under `<base>/projects/<sanitize(project)>/<repoShort>`.
// These functions mirror the Rust backend so the frontend can compute a repo's
// local path deterministically without round-tripping through Tauri.

/**
 * Canonicalize a project name into a filesystem-safe slug.
 *
 * Mirrors the Rust `sanitize_project_key`: ASCII alphanumerics and `-` are
 * kept, every other character becomes `_`, and the result is capped at 80
 * characters. ASCII-only on purpose so it matches the backend byte-for-byte.
 */
export function sanitizeProjectKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
}

/** The repo's short name — the segment after the last `/` in `owner/name`. */
export function repoShortName(fullName: string): string {
  const idx = fullName.lastIndexOf("/");
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

/**
 * Build the local clone path for a repo:
 * `<baseDir>/projects/<sanitizeProjectKey(projectName)>/<repoShortName(fullName)>`.
 *
 * The OS separator is inferred from `baseDir` (backslash on Windows, slash
 * elsewhere). Returns an empty string when `baseDir` is empty.
 */
export function projectRepoCwd(baseDir: string, projectName: string, fullName: string): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  return [baseDir, "projects", sanitizeProjectKey(projectName), repoShortName(fullName)].join(sep);
}

/**
 * The project hub directory — the planner's CWD and the parent of every repo
 * clone: `<baseDir>/projects/<sanitizeProjectKey(projectKey)>`. The fleet director
 * session runs here so it can see all repos as subdirectories. Mirrors the Rust
 * `project_dir`. Returns an empty string when `baseDir` is empty.
 */
export function projectHubCwd(baseDir: string, projectKey: string): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  return [baseDir, "projects", sanitizeProjectKey(projectKey)].join(sep);
}

/** Branch/dir slug for a fleet agent — keeps only `[A-Za-z0-9._-]`. Mirrors the
 *  Rust `worktree_slug` so the frontend path matches the backend's worktree. */
export function worktreeSlug(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * A fleet agent's git worktree directory — its isolated checkout + branch:
 * `<baseDir>/projects/<sanitizeProjectKey(projectKey)>/.worktrees/<repoShort>--<agentSlug>`.
 * Each agent edits/commits here on its own branch, so co-located agents (multiple
 * in one repo) never share a working tree. Mirrors the Rust `ensure_worktree` path.
 */
export function agentWorktreeCwd(baseDir: string, projectKey: string, fullName: string, agentId: string): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const dir = `${repoShortName(fullName)}--${worktreeSlug(agentId)}`;
  return [baseDir, "projects", sanitizeProjectKey(projectKey), ".worktrees", dir].join(sep);
}
