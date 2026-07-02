// Role gate (#219) — command classification + the role's command check. Classifies a shell command
// as a `git`/`gh` read or write, then decides whether a role's tier permits it. Pure enforcement
// core, free of React / xterm / Tauri. Re-exported from `sessionRoles.ts`.

import type { RoleCapability } from "./roleModel";

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
