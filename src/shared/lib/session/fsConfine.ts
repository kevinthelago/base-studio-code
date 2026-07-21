// Filesystem confinement (#158) — the file-tool axis of per-session repo isolation.
//
// A session for repo A shouldn't read/write files in sibling repos. The `bsc-confine`
// PreToolUse hook (gated panes) blocks Claude's file tools (Read/Edit/Write/MultiEdit/
// NotebookEdit) when their target path escapes the session's repo root. This module is
// the pure decision the hook mirrors in shell — so the rule is unit-tested even though
// the runtime check runs in bash.
//
// Deliberately conservative + string-based (no realpath, portable across OSes): any
// `..` segment is rejected, and an absolute path must sit under the repo root. It only
// covers the AI's file tools — true Bash-command confinement needs OS-level sandboxing.

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Absolute paths: POSIX (`/…`), home (`~…`), Windows drive (`C:…`), or UNC (`\\…`). */
function isAbsolute(p: string): boolean {
  return /^(\/|~|[A-Za-z]:)/.test(p) || p.startsWith("\\\\");
}

/** True if any path segment is a `..` (an upward traversal). */
function hasParentSegment(p: string): boolean {
  return normalize(p).split("/").some((seg) => seg === "..");
}

function underRoot(root: string, target: string): boolean {
  const r = normalize(root).replace(/\/+$/, "");
  const t = normalize(target);
  return t === r || t.startsWith(r + "/");
}

/**
 * Whether a file-tool target stays within `repoRoot`:
 * - empty path → confined (not a path op);
 * - any `..` segment → NOT confined (rejected conservatively, even within-repo);
 * - absolute path → confined only if it sits under `repoRoot`;
 * - plain relative path → confined (resolved against the repo-root cwd).
 */
export function isPathConfined(repoRoot: string, target: string): boolean {
  if (!target) return true;
  if (hasParentSegment(target)) return false;
  if (isAbsolute(target)) return underRoot(repoRoot, target);
  return true;
}

/**
 * Whether a **read** may reach `target` even though it sits OUTSIDE the repo root: it is an absolute
 * path under one of the session's declared read-only HARVEST roots (#3509 / #3530).
 *
 * #3509 widened what `bsc ui harvest` / `bsc graph harvest` may SCAN via `$BSC_HARVEST_ROOTS`, but the
 * session's Read tool is gated by the separate `bsc-confine` hook, which knew nothing of those roots — so
 * the designer could harvest components from the app repo yet not Read the sibling files they import
 * (the utility/hook/type modules harvest doesn't surface). This closes that: a Read of a harvest root is
 * allowed. It is deliberately **read-only** — only the caller's `Read` tool composes this; Write/Edit stay
 * confined — so a harvest root grants no write anywhere, matching the #3509 contract.
 *
 * Same conservatism as {@link isPathConfined}: a `..` segment is rejected, and only ABSOLUTE paths are
 * considered (a plain relative path resolves against the repo-root cwd, so it is in-repo by construction
 * and can only escape via `..`, which is already blocked). Empty roots contribute nothing.
 */
export function isUnderHarvestRoot(harvestRoots: readonly string[], target: string): boolean {
  if (!target || hasParentSegment(target) || !isAbsolute(target)) return false;
  return harvestRoots.some((r) => r && underRoot(r, target));
}

/**
 * Whether `target` is the session's OWN `.claude/` config (the hook list + permissions) — which the
 * file tools must never touch, even though it sits INSIDE the repo root (so {@link isPathConfined}
 * passes it). The `bsc-confine` hook blocks it too (#1916 config self-protection): an agent must not
 * be able to edit `settings.json` to remove the confinement hooks once a session runs under
 * `bypassPermissions`, where the `permissions.deny` rule that used to guard it is ignored. Only the
 * repo-root `.claude` is protected (a nested `src/.claude` is not the session config).
 */
export function isConfigProtected(repoRoot: string, target: string): boolean {
  if (!target) return false;
  const r = normalize(repoRoot).replace(/\/+$/, "");
  const t = normalize(target).replace(/\/+$/, "");
  const rel = (t === r ? "" : t.startsWith(r + "/") ? t.slice(r.length + 1) : t).replace(/^\.\//, "");
  return rel === ".claude" || rel.startsWith(".claude/");
}
