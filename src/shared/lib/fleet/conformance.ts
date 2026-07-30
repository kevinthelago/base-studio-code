// Deterministic fleet conformance check (#1102) — the non-injectable, no-LLM core of the
// warden. Given a session's TRUSTED plan anchor (its stream's owned globs + role + flow, all
// authored by the planner/app and none of it attacker-rewritable at runtime) and the session's
// observed activity (committed file changes + attempted shell commands), it flags anything
// off-plan: a diff outside the stream's lane, or a command the session's effective gate forbids
// (a role-denied write, or a push the flow blocks).
//
// Trust model: the watcher must be LESS exposed than the watched. This module reads ONLY
// structured, trusted signals — the plan anchor, the git diff, the bsc-audit command log — never
// the issue/PR/web prose a worker ingests, so it can't itself be steered by an injection. The
// fuzzy LLM judge is escalated to only ON a trip (or a sampled spot-check), off this hot path.
//
// Pure + unit-tested, so the warden wiring (who runs it, how often, the auto-pause response)
// layers on top without re-deriving the rules. Mirrors the launch gate exactly (role denies
// minus flow grants #304, plus the push a commit-only/none flow blocks) so it never flags a
// command the session is actually permitted to run.

import { matchGlob, roleDeniedCommands, type RoleCapability } from "../session/sessionRoles";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";
// shared/ is feature-agnostic (#1626), but the warden's conformance check MUST mirror the launch
// gate exactly, and the launch gate's push policy is derived by these two pure flow→permission
// functions. They depend transitively on the planner's `agentFlow` (AgentFlow/resolveFlow), so
// relocating them into shared would just pull the planner's flow domain along — disproportionate.
// Deliberate, scoped exception (the only feature VALUE import left in shared/, see #1626).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { flowGrantedPushCommands, flowPermissionRules } from "@/features/planner/fleet/flowPermissions";

/** GitHub-propagation commands the flow governs (mirrors flowPermissions' PUSH_WRITE_RULES). */
const PUSH_COMMANDS = ["git push", "gh pr create"];

/** The trusted, plan-sourced ground truth a session is checked against — its `AgentStream`
 *  fields (`id`, `owns`, role, `flow`), authored by the planner/app, not rewritable at runtime. */
export interface StreamAnchor {
  streamId: string;
  /** File globs the stream owns; writing outside them is off-lane. Empty ⇒ no lane constraint. */
  ownedGlobs: string[];
  /** The session's role gate (least privilege), with the stream's globs as its write boundary. */
  capability: RoleCapability;
  /** The session's execution flow (push policy). Unset ⇒ the default flow. */
  flow?: AgentFlow;
}

/** Observed, attributable activity for one session — collected by the warden from TRUSTED
 *  telemetry: `git diff --name-only` and the `bsc-audit` command log, never from prose. */
export interface SessionActivity {
  /** Repo-relative paths the session changed (committed or staged). */
  changedFiles: string[];
  /** Shell commands the session attempted (bsc-audit targets for the Bash tool). */
  commands: string[];
}

export type ConformanceTrip =
  | { kind: "out-of-glob"; detail: string }      // changed a file outside the stream's owned globs
  | { kind: "denied-command"; detail: string };  // attempted a command the effective gate forbids

export interface ConformanceVerdict {
  /** True when nothing tripped — the session looks on-plan by the deterministic checks. */
  onTask: boolean;
  trips: ConformanceTrip[];
}

/** The command prefixes the session's EFFECTIVE gate forbids: the role denies (minus any the
 *  flow grants, #304) plus the push commands a commit-only/none flow blocks. Mirrors the launch
 *  gate so the check never flags a command the session is actually allowed to run. */
export function effectiveDeniedCommands(cap: RoleCapability, flow?: AgentFlow): string[] {
  const granted = flowGrantedPushCommands(flow);
  const roleDenies = roleDeniedCommands(cap).filter((d) => !granted.includes(d));
  // A commit-only / none flow contributes a hard push deny (flowPermissionRules.denyToolRules);
  // auto-pr / push-confirm grant push instead, so nothing to add there.
  const flowDeniesPush = flowPermissionRules(flow).denyToolRules.length > 0;
  const pushDenies = flowDeniesPush ? PUSH_COMMANDS.filter((p) => !granted.includes(p)) : [];
  return Array.from(new Set([...roleDenies, ...pushDenies]));
}

/**
 * Files the APP authors, or explicitly instructs the agent to write (#3980). Never a worker's drift,
 * so never a lane trip.
 *
 * This is not a convenience carve-out — without it the warden punishes workers for the launch path's
 * own writes. Measured: 22 quarantined sessions, 20 of them for exactly these two files. The warden
 * KILLS the PTY when it quarantines, so each one was a dead session.
 *
 *  · `CLAUDE.local.md` — written by `ensure_worktree` → `write_worker_context`. It is the worker's own
 *    scope doc, placed in the worktree by the launcher. No stream's `owns` globs list it, because it
 *    is not the worker's file to claim — so it can never be in lane, for anyone.
 *  · `DECISIONS.md`    — `bsc-note`'s default target (`$BSC_DECISIONS_DOC`), a helper the app installs
 *    into every session via `BASH_ENV`. Using documented tooling must not be drift.
 *
 * A NAMED list, deliberately, not a pattern: a pattern like "dotfiles" or "looks like scratch" would
 * widen silently and hole the drift check. Agent-invented scratch (`.agentscratch.txt`, `.tmp-agent/…`)
 * is NOT here — that is the agent's own choice rather than the app's instruction, and it needs its own
 * decision rather than being swept in.
 */
export const APP_SANCTIONED_FILES: readonly string[] = ["CLAUDE.local.md", "DECISIONS.md"];

/** Whether the app itself owns this path (basename match — these live at the worktree root, but a
 *  nested copy is equally app-authored). Pure. */
export function isAppSanctioned(file: string): boolean {
  const base = file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return APP_SANCTIONED_FILES.includes(base);
}

/** Whether a changed file falls inside the stream's lane (its owned globs). A lane-less stream
 *  (no owned globs) imposes no file constraint. App-authored files are always in lane (#3980). */
function inLane(file: string, ownedGlobs: string[]): boolean {
  if (isAppSanctioned(file)) return true;
  return ownedGlobs.length === 0 || ownedGlobs.some((g) => matchGlob(g, file));
}

/** The forbidden prefix a command hits, or null. Whole-word at the boundary so "git pushy" does
 *  not match "git push" and "gh pr createx" does not match "gh pr create". */
function deniedPrefixHit(cmd: string, denied: string[]): string | null {
  const c = cmd.trim();
  for (const d of denied) {
    if (c === d || c.startsWith(d + " ")) return d;
  }
  return null;
}

/** Deterministic conformance check: is this session on-plan? No LLM, no untrusted input —
 *  a trip is the signal to pause + escalate, never a quiet pass that hides drift. */
export function checkConformance(anchor: StreamAnchor, activity: SessionActivity): ConformanceVerdict {
  const trips: ConformanceTrip[] = [];

  // 1. Files changed outside the stream's owned lane.
  for (const f of activity.changedFiles) {
    if (!inLane(f, anchor.ownedGlobs)) {
      trips.push({ kind: "out-of-glob", detail: f });
    }
  }

  // 2. Commands the session's effective gate forbids (role-denied or flow-blocked push).
  const denied = effectiveDeniedCommands(anchor.capability, anchor.flow);
  for (const c of activity.commands) {
    if (deniedPrefixHit(c, denied)) {
      trips.push({ kind: "denied-command", detail: c.trim() });
    }
  }

  return { onTask: trips.length === 0, trips };
}
