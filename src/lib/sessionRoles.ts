// Role-scoped session capabilities (#219) — least-privilege per session type. A
// session's abilities are bounded by its ROLE, so the planner can shape the plan but
// can't mutate the repo or GitHub, and any out-of-scope action is blocked (or
// escalated to an explicit user confirmation) rather than run freely.
//
// This is the pure enforcement core (command classification + path scoping); the
// gates that USE it are the per-pane command allowlist (resolveAllowedCommands) and a
// write-path guard on the write tool. Free of React / xterm / Tauri imports so it's
// unit-testable in isolation (matches allowedCommands.ts).

export type SessionRole =
  | "planner" | "worker" | "director" | "triage"
  // Pipeline-stage roles (#220): tester runs build/tests, reviewer reads + reviews,
  // conductor sequences stages. All are least-privilege (read-only, no code writes).
  | "tester" | "reviewer" | "conductor"
  // Issuer (#376): intake-only — shapes user requests into issues and may open GitHub
  // issues, but never touches code or git; routing is the director's job.
  | "issuer"
  // Juror (#394): a scoped reviewer that independently judges a landing against an
  // anchor (acceptance criteria / lens / subsystem slice). Read-only, like reviewer.
  | "juror";

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

// Plan-file globs auto-approved for the planner (#509). These are the section files
// the planning session writes directly: markdown sections, JSON manifests, and the
// prompts/ kickoff scripts. The planner still has no git/GitHub writes.
export const PLANNER_WRITE_GLOBS: string[] = [
  "*.md", "*.json", "prompts/*.md", "prompts/*",
];

/**
 * Default capability per role. `writeGlobs` are filled per assignment (a worker owns
 * its stream's globs); the defaults are empty so a session with no assigned boundary
 * can't write code. The **planner is plan-only** — read-only git/GitHub; its code writes
 * are scoped to plan-section files ({@link PLANNER_WRITE_GLOBS}) so it never needs a
 * permission prompt to write goal.md / phases.json / fleet.json / prompts/*.
 */
export const ROLE_DEFAULTS: Record<SessionRole, RoleCapability> = {
  planner: { role: "planner", github: "read", git: "read", code: "write", writeGlobs: PLANNER_WRITE_GLOBS },
  worker: { role: "worker", github: "read", git: "write", code: "write", writeGlobs: [] },
  director: { role: "director", github: "write", git: "write", code: "none", writeGlobs: [] },
  triage: { role: "triage", github: "write", git: "none", code: "none", writeGlobs: [] },
  // #220 stage roles -- least privilege: observe + report, never edit or merge.
  tester: { role: "tester", github: "read", git: "read", code: "none", writeGlobs: [] },
  reviewer: { role: "reviewer", github: "read", git: "read", code: "none", writeGlobs: [] },
  conductor: { role: "conductor", github: "read", git: "read", code: "none", writeGlobs: [] },
  // #376 issuer -- may open GitHub issues (github:write) but never writes code or git;
  // it only shapes intake and hands off to the director.
  issuer: { role: "issuer", github: "write", git: "read", code: "none", writeGlobs: [] },
  // #394 juror -- a scoped, read-only reviewer; judges, never edits or merges.
  juror: { role: "juror", github: "read", git: "read", code: "none", writeGlobs: [] },
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

// ── Launch wiring: write-tool permission rules ──────────────────────────────────

/** The file-mutating tools gated by the write-path guard. */
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export interface ToolPermissionRules {
  /** Rules to auto-approve (Claude Code `permissions.allow`). */
  allow: string[];
  /** Rules to block (`permissions.deny`; deny wins over allow). */
  deny: string[];
}

/**
 * Declarative `settings.json` permission rules that encode {@link canWritePath} for
 * the file-write tools at session launch — the write-tool counterpart to
 * {@link roleDeniedCommands}.
 *
 * - `code: "none"` (planner/director/triage) — {@link canWritePath} is always false,
 *   so deny every write tool outright (bare tool names = whole-tool deny).
 * - `code: "write"` with a boundary — auto-approve each `writeGlob` as
 *   `Tool(<glob>)` allow rules (exactly the paths {@link canWritePath} accepts).
 *   Writes outside the boundary fall through to Claude Code's default prompt; a
 *   hard outside-boundary *block* is the PreToolUse-hook follow-on.
 * - `code: "write"` with no boundary yet — no rules (writes follow the default),
 *   since the ownership globs aren't assigned to the pane.
 *
 * {@link canWritePath} stays the authoritative runtime predicate; these rules mirror
 * it into the tools at launch.
 */
export function roleWriteRules(cap: RoleCapability): ToolPermissionRules {
  if (cap.code === "none") {
    return { allow: [], deny: [...WRITE_TOOLS] };
  }
  const allow = cap.writeGlobs.flatMap((g) => WRITE_TOOLS.map((t) => `${t}(${g})`));
  return { allow, deny: [] };
}

// ── Launch wiring: command-allowlist denies ────────────────────────────────────

/** git write subcommand prefixes (the backend wraps each as `Bash(<prefix> *)`). */
const GIT_WRITE_DENY = [
  "git push", "git commit", "git merge", "git rebase", "git reset", "git revert",
  "git cherry-pick", "git tag", "git am", "git apply",
];

/** gh write command prefixes + writing `gh api` methods. */
const GH_WRITE_DENY = [
  "gh issue create", "gh issue edit", "gh issue close", "gh issue reopen",
  "gh issue comment", "gh issue delete", "gh issue lock", "gh issue transfer", "gh issue pin",
  "gh pr create", "gh pr merge", "gh pr close", "gh pr edit", "gh pr comment", "gh pr ready", "gh pr review",
  "gh label create", "gh label edit", "gh label delete",
  "gh release create", "gh release edit", "gh release delete",
  "gh repo create", "gh repo edit", "gh repo delete",
  "gh api --method POST", "gh api --method PATCH", "gh api --method PUT", "gh api --method DELETE",
  "gh api -X POST", "gh api -X PATCH", "gh api -X PUT", "gh api -X DELETE",
];

/**
 * Command-prefix denies to apply at session launch for a role, merged into the
 * session's `deniedCommands` (the backend wraps each as `Bash(<prefix> *)`, and a
 * specific deny overrides the broad `git`/`gh` allow). A first-layer gate: blocks the
 * args-bearing mutating commands while leaving reads alone. `none` tiers deny the tool
 * outright.
 *
 * This is the launch-time allowlist layer; complete subcommand-granular enforcement
 * (incl. no-arg variants) is a PreToolUse hook (follow-on), and the authoritative
 * publish gate is `checkCommand` at the executor call site.
 */
export function roleDeniedCommands(cap: RoleCapability): string[] {
  const out: string[] = [];
  if (cap.git === "none") out.push("git");
  else if (cap.git === "read") out.push(...GIT_WRITE_DENY);
  if (cap.github === "none") out.push("gh");
  else if (cap.github === "read") out.push(...GH_WRITE_DENY);
  return out;
}
