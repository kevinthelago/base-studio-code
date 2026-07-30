// Role gate (#219) — launch wiring. Renders a role's capability into the concrete permission
// artifacts a session is launched with: the write-tool `permissions.allow`/`deny` rules
// ({@link roleWriteRules}), whole-tool denies ({@link roleDeniedTools}), the command-prefix denies
// merged into the allowlist ({@link roleDeniedCommands}), and the bsc-agent-native permission doc
// ({@link bscAgentPerms}). Pure enforcement core, free of React / xterm / Tauri. Re-exported from
// `sessionRoles.ts`.

import type { AccessTier, RoleCapability } from "./roleModel";
import { DB_OWNED_PLAN_FILES, DEP_MANIFEST_FILES, hasScopedWriteCarveOut, isRestrictedRole, mayFileToolingRequest, TOOLING_REQUEST_COMMAND } from "./roleModel";

// ── Launch wiring: write-tool permission rules ──────────────────────────────────

/** The file-mutating tools gated by a WHOLE-TOOL deny (bare tool name, no path). Claude Code has no
 *  `MultiEdit` tool (removed) and a bare `Edit` deny does NOT cover `Write`/`NotebookEdit` — they are
 *  separate tools — so all three must be listed to block every file write (#3534). */
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

/** A PATH-SCOPED file rule uses ONLY `Edit(<glob>)`: Claude Code matches file-permission rules on the
 *  `Edit` tool alone, and that ONE rule covers every file-editing tool (Write/NotebookEdit). Emitting
 *  `Write(<glob>)`/`NotebookEdit(<glob>)`/`MultiEdit(<glob>)` produces rules Claude Code never matches —
 *  a silent no-op for an allow, and (worse) an unenforced deny (#3534). */
export const editPathRule = (glob: string): string => `Edit(${glob})`;

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
      return { allow: cap.writeGlobs.map(editPathRule), deny: [] };
    }
    return { allow: [], deny: [...WRITE_TOOLS] };
  }
  const allow = cap.writeGlobs.map(editPathRule);
  // Role-specific deny set, layered over the write-glob allows (deny wins over allow):
  // - planner: the DB-owned plan-state artifacts (#1070) — its *.md/*.json globs would otherwise
  //   auto-approve a stray `deploy.md`/`phases.json`; force it to the `bsc-plan` CLI.
  // - worker: the dependency manifests + lockfiles (#1111) — the planner locks deps once and
  //   publish seeds them, so a worker editing its own manifest is the parallel-redefinition that
  //   collides at integration; a new dep routes through the director.
  const denyFiles = cap.role === "planner" ? DB_OWNED_PLAN_FILES
    : cap.role === "worker" ? DEP_MANIFEST_FILES
    : [];
  const deny = denyFiles.map(editPathRule);
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

/** `bsc ui` (component/kit store) mutating verb prefixes (#2470) — denied at `ui: "read"` so a
 *  session can READ the kit it implements against but never redefine it. Includes the deprecated
 *  `bsc component` alias's verbs while that alias lives (#2469); deny-wins keeps these solid over
 *  the baseline's broad `bsc` allow. */
const UI_WRITE_DENY = [
  "bsc ui set", "bsc ui remove", "bsc ui kit set", "bsc ui kit remove",
  "bsc component set", "bsc component remove", "bsc component kit set", "bsc component kit remove",
];

/** File-mutating shell commands denied for a WRITE-LESS role (#2932) — the bash counterpart to the
 *  whole-tool Edit/Write deny in {@link roleWriteRules}. A `code: "none"` role with no scoped write
 *  carve-out writes NOTHING: not via the Edit/Write tools (already denied), and not via bash either —
 *  otherwise (as happened) a session bypasses the tool-deny with `tee`/`cp`/`echo > file` and mutates
 *  the repo (e.g. `src-tauri/data/`, triggering a rebuild). Denies the common file writers; shell
 *  redirection (`>`) can't be prefix-denied and is caught by the always-on `bsc-confine` FS hook.
 *  Carve-out roles (documentor/marketer/a commons director) and writers (planner/worker) are EXCLUDED —
 *  they write their scoped globs via the Write tool, not bash. */
const FILE_WRITE_DENY = [
  "tee", "dd", "truncate", "install", "cp", "mv", "ln", "patch", "sponge",
  "sed -i", "sed --in-place", "perl -i",
  "vi", "vim", "nano", "emacs", "ed", "ex",
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
  // UI store tier (#2470), rendered like git/gh. FAIL-CLOSED on the tier: only an explicit
  // `"write"` skips the mutating-verb denies, so a capability read from a STALE config-dir
  // override that predates the `ui` field (#2325 floor-merge hazard — the merged role OBJECT can
  // lack it) behaves as `"read"`, never as an accidental grant.
  if (cap.ui === "none") out.push("bsc ui", "bsc component");
  else if (cap.ui !== "write") out.push(...UI_WRITE_DENY);
  // A write-less role (code:none, no carve-out) writes NOTHING — deny the file-mutating bash commands
  // too, the counterpart to its whole-tool Edit/Write deny (#2932). Shell redirection (`>`) can't be
  // prefix-denied; the always-on `bsc-confine` FS hook is the complete layer.
  //
  // A RESTRICTED role keeps these denies even though it HAS a carve-out (#3373). Its carve-out is a
  // tool-only staging dir: it writes `scratch/**` with the Write tool and applies it with its one store
  // CLI. It has no business running `cp`/`mv`/`tee`/`sed -i` at all — its spec says in as many words
  // not to reach for bash to sidestep the file rules — so the shell mutation set stays denied. Without
  // this clause the carve-out would silently UN-deny them, widening the session well past the staging
  // dir the design intended.
  const carveOutWritesViaShell = hasScopedWriteCarveOut(cap) && !isRestrictedRole(cap.role);
  if (cap.code === "none" && !carveOutWritesViaShell) out.push(...FILE_WRITE_DENY);
  // The global tooling-request queue (#4000). `bsc` sits in the permission model's `mandatory` tier —
  // ALWAYS allowed, every role, every posture — so without this deny any worker could file straight
  // into the queue a full-capability session drains to edit base-studio-code itself. Not granting it
  // is not enough; only a deny keeps it out, because the hook is the sole layer that fires under
  // bypass (where `permissions.deny` is ignored).
  //
  // The pattern carries a SPACE, which matters: `deny_matches` (bsc-util/src/deny.rs) treats a bare
  // program name as a program-TOKEN match, but keeps substring semantics for anything else — so
  // "bsc request" matches `bsc request new …` while a bare "bsc" would have denied the entire CLI.
  if (!mayFileToolingRequest(cap.role)) out.push(TOOLING_REQUEST_COMMAND);
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
 *  denied. With no flow grant (the default), behavior is unchanged.
 *
 *  `cap` may be `null` for a role-less (ad-hoc) bsc-agent console — then only `extraDenyBash`
 *  applies. `extraDenyBash` is the user's global command denylist (`store.deniedCommands`), the
 *  parallel to the `...deniedCommands` the Claude path passes to `ensure_session_settings`; bsc-agent
 *  has no `.claude/settings.json`, so they must ride in here to be enforced. The catastrophic
 *  base floor (sudo / `rm -rf /` / force-push) is NOT listed here — it's an always-on floor inside
 *  the bsc-agent runtime ({@link ../../../../crates/bsc-agent BASE_DANGEROUS_BASH}), so it can't be
 *  dropped by an empty perm doc. */
export function bscAgentPerms(
  cap: RoleCapability | null,
  granted: string[] = [],
  extraDenyBash: string[] = [],
): BscAgentPerms {
  // The scoped carve-out (#851) applies here too: a `code: "none"` director WITH commons writeGlobs
  // keeps its write tools (scoped to the commons) rather than having them denied outright.
  const carveOut = cap ? hasScopedWriteCarveOut(cap) : false;
  const roleDenies = cap ? roleDeniedCommands(cap).filter((d) => !granted.includes(d)) : [];
  return {
    deny_tools: cap && cap.code === "none" && !carveOut ? ["write_file", "edit_file"] : [],
    deny_bash: [...new Set([...roleDenies, ...extraDenyBash.map((c) => c.trim()).filter(Boolean)])],
    write_globs: cap && (cap.code === "write" || carveOut) ? cap.writeGlobs : [],
  };
}

/** The per-store access-scope doc rendered into a gated session's `$BSC_SCOPES` env (#2470) — the
 *  runtime, defense-in-depth twin of the launch-time verb denies above. A store CLI reads it via
 *  `bsc_cli_util::scope_allows_write` and refuses its mutating verbs when the store is scoped
 *  read-only. Explicitly NOT a security boundary (a session owns its own env) — it guards accidents
 *  and non-Claude runtimes (`bsc-agent`, raw shells); {@link roleDeniedCommands} is the boundary.
 *  Currently just `ui`; other stores (`plan`, `skill`, `data`, …) adopt incrementally by adding
 *  their tier here. Missing tier ⇒ `"read"` (the same fail-closed floor as the deny rendering). */
export function sessionScopes(cap: RoleCapability): Record<string, AccessTier> {
  return { ui: cap.ui ?? "read" };
}
