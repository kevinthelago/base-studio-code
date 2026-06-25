// Pure resolution of a session's shell-command allowlist.
//
// Allowlists are configured at three scopes (global default, per-project, and
// per-repo — the latter two set during the planning phase) and combine
// ADDITIVELY: a repo session may run any command allowed globally, by its
// project, or for itself. The backend additionally guarantees `gh`/`git` for
// every session, so callers need not include them here.
//
// Free of React/Tauri imports so it can be unit-tested and shared.

/** Normalize a raw command entry: trimmed and lowercased. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().toLowerCase();
}

/**
 * Union the global, project, and repo command lists into one deduped allowlist,
 * in that precedence order (global first). Blank entries are dropped. Pure.
 */
export function resolveAllowedCommands(
  global: string[] = [],
  project: string[] = [],
  repo: string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [global, project, repo]) {
    for (const raw of list) {
      const c = normalizeCommand(raw);
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    }
  }
  return out;
}

export interface CommandsFile {
  /** Project-wide commands. */
  project: string[];
  /** Per-repo commands, keyed by repo full_name (owner/name). */
  repos: Record<string, string[]>;
}

/**
 * Parse the planner's `commands.json` allowlist file. This is the reliable
 * channel (the app polls it, like plan section files) for the planner to declare
 * a project's and its repos' shell commands. Shape:
 *   { "project": ["cargo"], "repos": { "owner/web": ["npm"] } }
 * Tolerant: bad JSON, missing keys, and non-string entries are dropped, yielding
 * empty lists rather than throwing.
 */
export function parseCommandsFile(content: string): CommandsFile {
  const empty: CommandsFile = { project: [], repos: {} };
  if (!content || !content.trim()) return empty;
  let data: unknown;
  try { data = JSON.parse(content); } catch { return empty; }
  if (!data || typeof data !== "object") return empty;
  const obj = data as Record<string, unknown>;
  const toList = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string").map(normalizeCommand).filter(Boolean))]
      : [];
  const repos: Record<string, string[]> = {};
  if (obj.repos && typeof obj.repos === "object") {
    for (const [k, v] of Object.entries(obj.repos as Record<string, unknown>)) {
      const list = toList(v);
      if (list.length) repos[k] = list;
    }
  }
  return { project: toList(obj.project), repos };
}
