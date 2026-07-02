// Role gate (#219) — write-path scoping. Translates the role's `writeGlobs` into an anchored
// matcher and answers the two write-scope questions: may a role write a given PATH
// ({@link canWritePath}), and what is the effective write-scope boundary for a pane
// ({@link scopeWriteGlobs}, what the `bsc-scope` PreToolUse hook hard-limits to). Pure enforcement
// core, free of React / xterm / Tauri. Re-exported from `sessionRoles.ts`.

import type { RoleCapability, SessionRole } from "./roleModel";
import { roleCapability, hasScopedWriteCarveOut } from "./roleModel";

/**
 * The effective write-scope globs for a pane's role (#1297) — what the `bsc-scope` PreToolUse hook
 * hard-limits writes to. Uses the pane's assigned owned globs when it has them, else the role's
 * default boundary, so the planner falls back to {@link PLANNER_WRITE_GLOBS} rather than being
 * overridden to `[]`. Empty ⇒ the role has no write boundary (a `code: "none"` role with no
 * carve-out, or a worker with no lane yet) and so gets no scope hook. A `code: "none"` role WITH an
 * explicit carve-out (the director's commons, #851) is scoped to exactly those globs — so the
 * scope hook hard-blocks any director write outside the commons.
 */
export function scopeWriteGlobs(role: SessionRole, ownGlobs: string[]): string[] {
  const cap = roleCapability(role, ownGlobs.length ? { writeGlobs: ownGlobs } : {});
  if (cap.code === "write") return cap.writeGlobs;
  return hasScopedWriteCarveOut(cap) ? cap.writeGlobs : [];
}

// ── Write-path scoping ──────────────────────────────────────────────────────────

/** Translate a path glob (`*` = non-slash run, `**` = any) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when `path` matches `glob`. */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/**
 * Whether a role may write `path`: it needs `code` access AND the path must fall
 * inside one of its `writeGlobs`. No globs ⇒ no boundary ⇒ no code writes (a worker
 * must be assigned its ownership boundary first).
 *
 * The one exception is the scoped carve-out (#851): a `code: "none"` role that carries explicit
 * `writeGlobs` (the director's commons) may write paths inside those globs and nothing else — the
 * carve-out grants exactly the listed paths while every other write stays denied.
 */
export function canWritePath(cap: RoleCapability, path: string): boolean {
  if (cap.code === "none" && !hasScopedWriteCarveOut(cap)) return false;
  return cap.writeGlobs.some((g) => matchGlob(g, path));
}
