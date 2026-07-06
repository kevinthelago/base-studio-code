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

/**
 * The canonical project key — a **readable slug of the project NAME** (#2409). This is the project's
 * single identity: it names the on-disk hub (`projects/<key>/`), plan.db, the DuckDB store, fleet
 * worktrees, the session skill group, the pane ids (`<key>:<stream>`), every app-state map key, and —
 * 1:1 — the GitHub project (`projectSlug(github.name)`). Frozen at creation, so recovery DERIVES every
 * path from the name instead of a lookup table (retiring the opaque minted id + the alias bridge, #1741).
 *
 * Lowercase `[a-z0-9-]`, non-alnum runs → one `-`, edges trimmed, capped at 60 chars; an empty result
 * (emoji-only / non-latin names) falls back to `"project"`. Already slug-safe, so the backend
 * `sanitize_project_key` is a no-op on it. Two different names that slug to the SAME key collide — that's
 * resolved at creation by a modal, so keys stay unique by construction (no opaque disambiguator needed).
 */
export function projectSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "project";
}

/** The repo's short name — the segment after the last `/` in `owner/name`. */
export function repoShortName(fullName: string): string {
  const idx = fullName.lastIndexOf("/");
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

/**
 * Where a catalog MCP server is downloaded: `<baseDir>/mcp/<name>` (#859 follow-up).
 * Mirrors the Rust `mcp_install_dir` so the frontend can reference the cloned path in a
 * run config. Returns "" when `baseDir` is empty.
 */
export function mcpInstallDir(baseDir: string, name: string): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  return [baseDir, "mcp", name].join(sep);
}

/**
 * Build the local clone path for a repo:
 * `<baseDir>/projects/<sanitizeProjectKey(projectName)>/<repoShortName(fullName)>`.
 *
 * The OS separator is inferred from `baseDir` (backslash on Windows, slash
 * elsewhere). Returns an empty string when `baseDir` is empty.
 */
export function projectRepoCwd(baseDir: string, projectName: string, fullName: string, _published = true): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  // Single hub root since #922: every hub lives under projects/<key>, published or draft (the hub
  // never moves; published-ness is the in-place `.published` marker). `_published` is retained for
  // call-site compatibility and no longer affects the path.
  return [baseDir, "projects", sanitizeProjectKey(projectName), repoShortName(fullName)].join(sep);
}

/**
 * The project hub directory — the planner's CWD and the parent of every repo
 * clone: `<baseDir>/projects/<sanitizeProjectKey(projectKey)>`. The fleet director
 * session runs here so it can see all repos as subdirectories. Mirrors the Rust
 * `project_dir`. Returns an empty string when `baseDir` is empty.
 */
export function projectHubCwd(baseDir: string, projectKey: string, _published = true): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  // Single hub root since #922: every hub lives under projects/<key>, published or draft (the hub
  // never moves). `_published` is retained for call-site compatibility and no longer affects the path.
  return [baseDir, "projects", sanitizeProjectKey(projectKey)].join(sep);
}

/** Branch/dir slug for a fleet agent — keeps only `[A-Za-z0-9._-]`. Mirrors the
 *  Rust `worktree_slug` so the frontend path matches the backend's worktree. */
export function worktreeSlug(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * A fleet agent's git worktree directory — its isolated checkout + branch:
 * `<baseDir>/worktrees/<sanitizeProjectKey(projectKey)>/<repoShort>--<agentSlug>`.
 *
 * OUTSIDE the project hub (`projects/<key>/`) on purpose (#844): Claude Code loads
 * `CLAUDE.md` from the cwd and every parent dir, so a worktree under the hub inherits the
 * hub's planner spec — pulling the worker toward planning and inflating per-turn input
 * tokens. Relocating worktrees here keeps the planner `CLAUDE.md` out of the ancestor walk.
 * Each agent edits/commits here on its own branch, so co-located agents (multiple in one
 * repo) never share a working tree. Mirrors the Rust `ensure_worktree` / `worktrees_dir`.
 */
export function agentWorktreeCwd(baseDir: string, projectKey: string, fullName: string, agentId: string): string {
  if (!baseDir) return "";
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const dir = `${repoShortName(fullName)}--${worktreeSlug(agentId)}`;
  return [baseDir, "worktrees", sanitizeProjectKey(projectKey), dir].join(sep);
}

/**
 * Whether `draftKey` (a sanitized project name) belongs to a project already published to
 * GitHub — i.e. some node id in `projectKeyAlias` maps to it. The draft clean-start delete
 * (#379/#380) must never fire for such a key: re-using a published project's name would
 * otherwise wipe its plan folder even if the GitHub project list hasn't loaded yet.
 */
export function isKnownPublishedKey(draftKey: string, projectKeyAlias: Record<string, string>): boolean {
  return Object.values(projectKeyAlias).includes(draftKey);
}

/**
 * Resolve a planning session's raw key to its single canonical workspace key (#380).
 *
 * A project reached via the board carries only its GitHub Project node id, but its plan
 * files / cloned repos / fleet live under the stable folder key the planner first used;
 * `projectKeyAlias` maps that node id → folder key. EVERYTHING that reads or writes
 * per-project data (plan sections, `projectLocalRepos`, fleet) must key off this one
 * resolved value, so a write under one form and a later read under another can't diverge
 * — the bug that made a re-triggered planning session clone unrelated repos / lose them.
 * Returns `rawKey` unchanged when no alias maps it (a local-only draft already uses its
 * canonical key).
 */
export function resolveProjectKey(rawKey: string, projectKeyAlias: Record<string, string>): string {
  return projectKeyAlias[rawKey] ?? rawKey;
}

/**
 * The first item whose title matches `title`, comparing case-insensitively and ignoring
 * surrounding whitespace; `null` when none (or `title` is blank). One matcher for the
 * local draft-title conflict guard (#380) and the GitHub board adopt-vs-create check
 * (#444), so "does a project with this title already exist?" is decided one way.
 */
export function findByTitle<T>(items: readonly T[], title: string, getTitle: (item: T) => string): T | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(title);
  if (!target) return null;
  return items.find((it) => norm(getTitle(it)) === target) ?? null;
}

/**
 * The canonical, sanitized identity key for a project's workspace + tabs (#457/#380).
 *
 * Prefers an explicit `projectId` (a GitHub Project node id — stable across display-name
 * renames) and falls back to the project's display name when no id exists yet (a
 * local-only draft). Always passed through {@link sanitizeProjectKey} so callers compare
 * one canonical form, never a raw name in one place and a sanitized id in another — the
 * key-divergence that let a rename fork a duplicate tab / clone into the wrong folder.
 */
export function canonicalProjectKey(projectName: string, projectId?: string): string {
  const id = (projectId ?? "").trim();
  return sanitizeProjectKey(id || projectName);
}

/** The kind of project-owned console tab (#457): a fleet "· build" tab or a "· triage" tab. */
export type ProjectTabKind = "build" | "triage";

/**
 * Minimal shape of a tab for project-identity matching (#457). `Tab` (Tabstrip) is a
 * structural superset, so callers pass `store.tabs` directly without importing it here.
 */
export interface ProjectTabRef {
  projectKey?: string;
  kind?: ProjectTabKind;
  seq?: number;
}

/**
 * Index of the fleet/triage tab that belongs to a project, matched on the STABLE
 * `projectKey` + `kind` (+ build `seq`) — never the derived display name (#457). A
 * project rename changes the tab's label but not its `projectKey`, so the reuse lookup
 * still finds it and rebuilds in place instead of forking a duplicate "· build" tab (the
 * "two directors" bug). Returns -1 when no matching tab exists.
 *
 * @param seq 0-based build-tab sequence (0 = primary "· build", 1 = "· build 2", …);
 *            ignored for triage, which has a single tab per project.
 */
export function findProjectTabIdx(
  tabs: readonly ProjectTabRef[],
  projectKey: string,
  kind: ProjectTabKind,
  seq = 0,
): number {
  return tabs.findIndex(
    (t) =>
      t.projectKey === projectKey &&
      t.kind === kind &&
      (kind === "triage" || (t.seq ?? 0) === seq),
  );
}

const TRIAGE_SUFFIX = " · triage";
// "<name> · build" (seq 0) or "<name> · build N" (seq N-1, N ≥ 2). Greedy name capture so
// a project whose own name contains " · build" still resolves to the trailing suffix.
const BUILD_NAME_RE = /^(.*) · build(?: (\d+))?$/;

/**
 * Back-derive a fleet/triage tab's stable identity from its display name (#457 migration).
 *
 * Persisted tabs created before `projectKey`/`kind`/`seq` existed only carry the frozen
 * `name`. On rehydrate we parse that name once so the reuse lookup has a key to match.
 * The key is the sanitized name portion — the best available identity for a legacy tab;
 * tabs created after the migration carry the stable id set at launch. Returns `null` for
 * a name that is not a project tab (an ad-hoc / manually-named tab keeps no identity).
 */
export function deriveTabIdentity(
  name: string,
): { projectKey: string; kind: ProjectTabKind; seq: number } | null {
  if (name.endsWith(TRIAGE_SUFFIX)) {
    return { projectKey: sanitizeProjectKey(name.slice(0, -TRIAGE_SUFFIX.length)), kind: "triage", seq: 0 };
  }
  const m = BUILD_NAME_RE.exec(name);
  if (m) {
    const seq = m[2] ? Number(m[2]) - 1 : 0;
    return { projectKey: sanitizeProjectKey(m[1]), kind: "build", seq };
  }
  return null;
}
