// Role-scoped session capabilities (#219) — least-privilege per session type. A
// session's abilities are bounded by its ROLE, so the planner can shape the plan but
// can't mutate the repo or GitHub, and any out-of-scope action is blocked (or
// escalated to an explicit user confirmation) rather than run freely.
//
// This is the pure enforcement core (command classification + path scoping); the
// gates that USE it are the per-pane command allowlist (resolveAllowedCommands) and a
// write-path guard on the write tool. Free of React / xterm / Tauri imports so it's
// unit-testable in isolation (matches allowedCommands.ts).

export type SessionRole = "planner" | "worker" | "director" | "triage";

/** Access to a capability: none < read < write. */
export type AccessTier = "none" | "read" | "write";

export interface RoleCapability {
  role: SessionRole;
  /** GitHub: `gh` writes / API mutations. */
  github: AccessTier;
  /** Local git: commit/push/merge are writes; status/log are reads. */
  git: AccessTier;
  /** Editing files on disk (outside any dedicated plan channel). */
  code: AccessTier;
  /** Path globs this role/assignment may write. Empty ⇒ no code writes. */
  writeGlobs: string[];
}

/**
 * Default capability per role. `writeGlobs` are filled per assignment (a worker owns
 * its stream's globs); the defaults are empty so a session with no assigned boundary
 * can't write code. The **planner is plan-only** — read-only git/GitHub, no code; its
 * plan writes go through a dedicated channel, not the filesystem guard.
 */
export const ROLE_DEFAULTS: Record<SessionRole, RoleCapability> = {
  planner: { role: "planner", github: "read", git: "read", code: "none", writeGlobs: [] },
  worker: { role: "worker", github: "read", git: "write", code: "write", writeGlobs: [] },
  director: { role: "director", github: "write", git: "write", code: "none", writeGlobs: [] },
  triage: { role: "triage", github: "write", git: "none", code: "none", writeGlobs: [] },
};

/** A role capability, optionally narrowed/widened per assignment (e.g. writeGlobs). */
export function roleCapability(role: SessionRole, override: Partial<RoleCapability> = {}): RoleCapability {
  return { ...ROLE_DEFAULTS[role], ...override };
}

// ── Command classification ──────────────────────────────────────────────────────

const GIT_WRITE = new Set([
  "push", "commit", "merge", "rebase", "reset", "revert", "cherry-pick", "tag", "am",
  "apply", "branch", "checkout", "switch", "restore", "stash", "mv", "rm", "add", "clean",
]);

const GH_WRITE_VERBS = new Set([
  "create", "edit", "delete", "close", "reopen", "merge", "comment", "add", "remove",
  "develop", "ready", "lock", "unlock", "transfer", "pin", "unpin", "rename", "sync",
]);

const HTTP_WRITE = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface CommandClass {
  /** The leading binary (`git`, `gh`, `npm`, …). */
  tool: string;
  /** True when the command mutates state (a write). */
  mutating: boolean;
}

/**
 * Classify a shell command as a `git`/`gh` read or write (other tools are reported as
 * non-mutating — they're gated elsewhere). `gh api` is mutating when its method
 * (`--method` / `-X`) is a write verb.
 */
export function classifyCommand(cmd: string): CommandClass {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  const tool = tokens[0] ?? "";

  if (tool === "git") {
    return { tool, mutating: GIT_WRITE.has(tokens[1] ?? "") };
  }
  if (tool === "gh") {
    if (tokens[1] === "api") {
      const flag = tokens.indexOf("--method") >= 0 ? "--method" : "-X";
      const i = tokens.indexOf(flag);
      const method = (i >= 0 ? tokens[i + 1] ?? "" : "GET").toUpperCase();
      return { tool, mutating: HTTP_WRITE.has(method) };
    }
    return { tool, mutating: GH_WRITE_VERBS.has(tokens[2] ?? "") };
  }
  return { tool, mutating: false };
}

export interface CommandDecision {
  allowed: boolean;
  /** A clear, non-technical reason when denied. */
  reason?: string;
}

/**
 * Decide whether a role may run a command. Only `git`/`gh` are gated here (other
 * tools pass — they're handled by the command allowlist). Tier rules: `none` denies
 * all, `read` allows non-mutating only, `write` allows all.
 */
export function checkCommand(cap: RoleCapability, cmd: string): CommandDecision {
  const { tool, mutating } = classifyCommand(cmd);
  const tier = tool === "gh" ? cap.github : tool === "git" ? cap.git : null;
  if (tier === null) return { allowed: true };
  if (tier === "none") {
    return { allowed: false, reason: `the ${cap.role} role has no ${tool} access` };
  }
  if (mutating && tier === "read") {
    return { allowed: false, reason: `the ${cap.role} role can read but not modify via ${tool}` };
  }
  return { allowed: true };
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
 */
export function canWritePath(cap: RoleCapability, path: string): boolean {
  if (cap.code === "none") return false;
  return cap.writeGlobs.some((g) => matchGlob(g, path));
}
