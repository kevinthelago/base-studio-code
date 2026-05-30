# Role-scoped session capabilities (#219)

Least-privilege per session type. A session's abilities are bounded by its **role**, so a
planner can shape the plan but can't mutate the repo or GitHub, and any out-of-scope action
is blocked (or escalated to explicit user confirmation) rather than run freely. Pure
enforcement core in `src/lib/sessionRoles.ts`; the gates that *use* it are the per-pane
command allowlist (`resolveAllowedCommands`) and a write-path guard on the write tool.

## Roles & default capabilities

| Role | github | git | code | Notes |
|---|---|---|---|---|
| **planner** | read | read | none | **plan-only** — proposes; never mutates repo/GitHub. Plan writes go through a dedicated channel, not the FS guard. |
| **worker** | read | write | write (within globs) | implements within its assigned ownership boundary; commits. |
| **director** | write | write | none | merges PRs, manages issues/milestones; no feature code. |
| **triage** | write | none | none | issue comments/labels only. |

`writeGlobs` are filled per assignment (a worker owns its stream's globs); the defaults are
empty, so a session with no boundary can't write code.

## Enforcement

- **`classifyCommand(cmd)`** → `{ tool, mutating }`. Knows `git` write subcommands
  (push/commit/merge/…) and `gh` write verbs (create/edit/merge/…), incl. `gh api --method`.
- **`checkCommand(capability, cmd)`** → `{ allowed, reason? }`. Tier rules: `none` denies
  all, `read` allows non-mutating only, `write` allows all. Other tools pass (gated by the
  command allowlist).
- **`canWritePath(capability, path)`** — needs `code` access AND a `writeGlobs` match
  (`matchGlob` supports `*` / `**`).

## Launch wiring

A pane's role lives in the store as `paneRoles[paneId]` (transient; absent ⇒ unrestricted,
the current behavior). At session launch, `TerminalView` merges **`roleDeniedCommands(cap)`**
into the session's `deniedCommands` passed to `ensure_session_settings`. The backend wraps
each entry as `Bash(<prefix> *)`, and a specific deny overrides the broad `gh`/`git` allow —
so a planner gets git/gh **writes** denied (`git push`, `gh issue create`, `gh api --method
POST`, …) while reads remain. `none` tiers deny the tool outright (`triage` → no `git`).

This is the launch-time **allowlist** layer. It blocks args-bearing mutating commands;
complete subcommand-granular enforcement (incl. no-arg variants) is a `PreToolUse` **hook**
(follow-on), and the authoritative publish gate is `checkCommand` at the executor call site.

## Why this gates publishing

The publish executor (#230 / #232) mutates GitHub, so it must only run for a role with
`github: "write"` (director) or behind an explicit user-confirmed Publish action — never
from a planner session. The same model scopes repo-level credentials (#158) — repo scope ×
role scope are the two axes of the least-privilege model.
