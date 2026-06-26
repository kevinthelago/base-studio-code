// Role-scoped session capabilities (#219) — least-privilege per session type. A
// session's abilities are bounded by its ROLE, so the planner can shape the plan but
// can't mutate the repo or GitHub, and any out-of-scope action is blocked (or
// escalated to an explicit user confirmation) rather than run freely.
//
// This is the pure enforcement core (command classification + path scoping); the
// gate that USES it is the role's denied-command set plus a write-path guard on the
// write tool, applied alongside the per-agent profile (#1457). Free of React / xterm /
// Tauri imports so it's unit-testable in isolation.

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
  /** Network/web tools (`WebFetch`, `WebSearch`) — a live prompt-injection vector (#1107). `none`
   *  denies them outright at launch; `read` permits fetching, whose RESULTS the session must treat
   *  as untrusted data (the planner template frames this). This is the gate the per-agent `net`
   *  profile (#289) ties into; `write` is unused (there's no "network write" tool to grant). */
  net: AccessTier;
  /** Path globs this role/assignment may write. Empty ⇒ no code writes. */
  writeGlobs: string[];
}

// Plan-file globs auto-approved for the planner (#509). These are the section files
// the planning session writes directly: markdown sections, JSON manifests, and the
// prompts/ kickoff scripts. The planner still has no git/GitHub writes.
export const PLANNER_WRITE_GLOBS: string[] = [
  "*.md", "*.json", "prompts/*.md", "prompts/*",
  // Context-stage discovery sections live in their own subdir (#807).
  "context/*.md", "context/*",
];

// Structured plan state that lives in plan.db, written ONLY via the `bsc-plan` CLI
// (repo/phase/feature/fleet/deploy). The planner must never write these as FILES — a stray
// `deploy.md` / `phases.json` doesn't feed the DB or clear a stage gate, it just rots (#1070).
// {@link roleWriteRules} denies their file forms for the planner so its `*.md`/`*.json` write glob
// can't auto-approve them (deny > allow); the planner is forced to the CLI. Section files
// (`goal.md`, `scope.md`, …) stay writable.
export const DB_OWNED_PLAN_FILES: string[] = [
  "deploy.md", "deploy.json",
  "phases.json", "issues.json", "fleet.json", "repos.json", "features.json",
];

// Dependency manifests + lockfiles a WORKER must not hand-edit (#1111). The planner locks the
// project's dependencies once and publish seeds these into every repo; a worker that edits its
// own manifest in its worktree is exactly the parallel-redefinition that collides at integration.
// {@link roleWriteRules} denies the file-write tools on these for workers (deny > allow) even when
// the path falls inside the worker's owned globs — a new dep routes through the director instead.
// (This gates the Edit/Write TOOLS only; `npm install` / `cargo build` via Bash still regenerate
// lockfiles normally, so installing the already-locked deps is unaffected.)
export const DEP_MANIFEST_FILES: string[] = [
  "package.json", "package-lock.json",
  "Cargo.toml", "Cargo.lock",
  "pnpm-lock.yaml", "yarn.lock",
];

/**
 * Default capability per role. `writeGlobs` are filled per assignment (a worker owns
 * its stream's globs); the defaults are empty so a session with no assigned boundary
 * can't write code. The **planner is plan-only** — read-only git/GitHub; its code writes
 * are scoped to plan-section files ({@link PLANNER_WRITE_GLOBS}) so it never needs a
 * permission prompt to write goal.md / phases.json / fleet.json / prompts/*.
 */
// `net: "read"` across the board preserves today's behavior (WebFetch is currently allowed for
// every session via the broad Bash grant). The field exists so a per-agent `net` profile (#289) — or
// a future planner "no web" toggle (#1107) — can set `none` to deny WebFetch/WebSearch at launch.
export const ROLE_DEFAULTS: Record<SessionRole, RoleCapability> = {
  planner: { role: "planner", github: "read", git: "read", code: "write", net: "read", writeGlobs: PLANNER_WRITE_GLOBS },
  worker: { role: "worker", github: "read", git: "write", code: "write", net: "read", writeGlobs: [] },
  director: { role: "director", github: "write", git: "write", code: "none", net: "read", writeGlobs: [] },
  triage: { role: "triage", github: "write", git: "none", code: "none", net: "read", writeGlobs: [] },
  // #220 stage roles -- least privilege: observe + report, never edit or merge.
  tester: { role: "tester", github: "read", git: "read", code: "none", net: "read", writeGlobs: [] },
  reviewer: { role: "reviewer", github: "read", git: "read", code: "none", net: "read", writeGlobs: [] },
  conductor: { role: "conductor", github: "read", git: "read", code: "none", net: "read", writeGlobs: [] },
  // #376 issuer -- may open GitHub issues (github:write) but never writes code or git;
  // it only shapes intake and hands off to the director.
  issuer: { role: "issuer", github: "write", git: "read", code: "none", net: "read", writeGlobs: [] },
  // #394 juror -- a scoped, read-only reviewer; judges, never edits or merges.
  juror: { role: "juror", github: "read", git: "read", code: "none", net: "read", writeGlobs: [] },
};

/** A role capability, optionally narrowed/widened per assignment (e.g. writeGlobs). */
export function roleCapability(role: SessionRole, override: Partial<RoleCapability> = {}): RoleCapability {
  return { ...ROLE_DEFAULTS[role], ...override };
}

/**
 * Whether a capability has the director's explicit, scoped write carve-out (#851): the **director**
 * keeps `code: "none"` (no feature-code writes) yet is allowed to write EXACTLY the commons globs it
 * owns (`.gitignore`, manifests, CI config, …) when they're assigned to it. This mirrors the #304
 * precedent of a scoped role-gate carve-out — a narrow, explicit allow layered onto an
 * otherwise-denied capability. Scoped to the director role on purpose: every OTHER `code: "none"`
 * role (triage, tester, reviewer, …) stays fully write-denied even if handed globs, so the commons
 * stewardship can't be accidentally granted to a non-integrator. An empty `writeGlobs` (the default)
 * ⇒ no carve-out, full deny stands.
 */
export function hasScopedWriteCarveOut(cap: RoleCapability): boolean {
  return cap.role === "director" && cap.code === "none" && cap.writeGlobs.length > 0;
}

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
 *
 * The one exception is the scoped carve-out (#851): a `code: "none"` role that carries explicit
 * `writeGlobs` (the director's commons) may write paths inside those globs and nothing else — the
 * carve-out grants exactly the listed paths while every other write stays denied.
 */
export function canWritePath(cap: RoleCapability, path: string): boolean {
  if (cap.code === "none" && !hasScopedWriteCarveOut(cap)) return false;
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
    // Scoped carve-out (#851): a `code: "none"` role WITH explicit writeGlobs (the director's
    // commons) auto-approves the write tools for EXACTLY those globs. Claude Code's precedence is
    // deny > allow, so the whole-tool deny would mask any narrower allow — instead of denying the
    // bare tools we emit only the per-glob allows. Any write OUTSIDE the commons falls through to
    // the default prompt and is hard-blocked by the bsc-scope hook ({@link scopeWriteGlobs}), so
    // the director can write the commons and is denied all other code writes.
    if (hasScopedWriteCarveOut(cap)) {
      return { allow: cap.writeGlobs.flatMap((g) => WRITE_TOOLS.map((t) => `${t}(${g})`)), deny: [] };
    }
    return { allow: [], deny: [...WRITE_TOOLS] };
  }
  const allow = cap.writeGlobs.flatMap((g) => WRITE_TOOLS.map((t) => `${t}(${g})`));
  // Role-specific deny set, layered over the write-glob allows (deny wins over allow):
  // - planner: the DB-owned plan-state artifacts (#1070) — its *.md/*.json globs would otherwise
  //   auto-approve a stray `deploy.md`/`phases.json`; force it to the `bsc-plan` CLI.
  // - worker: the dependency manifests + lockfiles (#1111) — the planner locks deps once and
  //   publish seeds them, so a worker editing its own manifest is the parallel-redefinition that
  //   collides at integration; a new dep routes through the director.
  const denyFiles = cap.role === "planner" ? DB_OWNED_PLAN_FILES
    : cap.role === "worker" ? DEP_MANIFEST_FILES
    : [];
  const deny = denyFiles.flatMap((f) => WRITE_TOOLS.map((t) => `${t}(${f})`));
  return { allow, deny };
}

/**
 * Whole-tool denies by role BEYOND the write-path tools (#1036) — currently the sub-agent **Task**
 * tool for **workers**. A worker must not spawn its OWN sub-agents: each spawned agent reads as
 * fresh activity that the always-on coordinator keeps trying to relaunch the worker for (a wake
 * request every poll), and it blurs the worker's lane. A worker does its assigned issue directly;
 * spinning up helper sessions is the director's job. Denied by bare tool name — the same whole-tool
 * deny {@link roleWriteRules} uses for Edit/Write — so it's a hard block at launch, no prompt, no
 * delay. Merged into `denyToolRules` at session launch.
 */
export function roleDeniedTools(cap: RoleCapability): string[] {
  const out: string[] = [];
  if (cap.role === "worker") out.push("Task");
  // Network gate (#1107): `net: "none"` denies the web tools outright at launch — the lever that
  // turns OFF the planner's (or any agent's) live injection surface. `read` (the default) leaves
  // them allowed, with results framed as untrusted data.
  if (cap.net === "none") out.push("WebFetch", "WebSearch");
  return out;
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

/** The permission doc the `bsc-agent` runtime reads from `$BSC_AGENT_PERMS` (#1078 P3) — the
 *  generic role model rendered to bsc-agent's native shape (vs the Claude `.claude/settings.json`
 *  syntax {@link roleWriteRules}/{@link roleDeniedTools} produce). `code: "none"` denies the
 *  write/edit tools outright; `deny_bash` reuses {@link roleDeniedCommands} (substring-matched by
 *  bsc-agent — coarser than Claude's prefix allowlist); `write_globs` scopes a writer to its lane. */
export interface BscAgentPerms {
  deny_tools: string[];
  deny_bash: string[];
  write_globs: string[];
}

/** Render the role capability to bsc-agent's native permission doc. `granted` are the
 *  GitHub-propagation commands the pane's *flow* permits (from {@link flowGrantedPushCommands}):
 *  the flow owns `git push` / `gh pr create`, so they're lifted from the role denies when it
 *  permits pushing/PRing — mirroring the Claude role↔flow reconciliation (#304) so an `auto-pr`
 *  bsc-agent worker (github:read) can open its own PR. Everything else the role denies stays
 *  denied. With no flow grant (the default), behavior is unchanged. */
export function bscAgentPerms(cap: RoleCapability, granted: string[] = []): BscAgentPerms {
  // The scoped carve-out (#851) applies here too: a `code: "none"` director WITH commons writeGlobs
  // keeps its write tools (scoped to the commons) rather than having them denied outright.
  const carveOut = hasScopedWriteCarveOut(cap);
  return {
    deny_tools: cap.code === "none" && !carveOut ? ["write_file", "edit_file"] : [],
    deny_bash: roleDeniedCommands(cap).filter((d) => !granted.includes(d)),
    write_globs: cap.code === "write" || carveOut ? cap.writeGlobs : [],
  };
}
