// The AUTO-SPAWN GATE (#3498) — the ONE place that may authorise starting a session without a human
// asking for it. Nothing else in the app is allowed to make that call.
//
// ── WHY THIS IS A GATE AND NOT A CONDITION ──────────────────────────────────────────────────────────
// Automatic session spawning is the highest-consequence capability in the app: a session runs a real
// LLM against a real repo with real credentials, and one that spawns itself can do so repeatedly. The
// maintainer's constraint is therefore explicit — ONLY the debug session may ever be spawned
// automatically, and only while a Settings toggle is on. This module is the enforcement point, kept
// separate from the spawning mechanism so the lock can exist (and be tested) before any door does.
//
// ── THE THREE INDEPENDENT CONDITIONS, ALL FAIL-CLOSED ───────────────────────────────────────────────
//  1. The setting is ON. Default OFF; anything that is not literally `true` reads as off, so a missing,
//     undefined, or corrupted value disables auto-spawn rather than enabling it.
//  2. The role is EXACTLY {@link AUTO_SPAWNABLE_ROLE}. This is an ALLOW-LIST of one, never a deny-list:
//     a role added to `SessionRole` later is refused by default instead of quietly inheriting the
//     capability. That is the same reasoning that makes the restricted-role command surface an
//     allow-list — the failure mode of a deny-list is silent over-permission.
//  3. The caller is the request-intake path. Enforced by this being the only exported authoriser: a
//     second spawn path is the bug to prevent, so `autoSpawnDecision` is the single funnel and its
//     refusals carry a reason rather than returning a bare `false`.
//
// A refusal is never silent — {@link autoSpawnDecision} names WHY, so a blocked spawn is diagnosable
// instead of looking like nothing happened (the failure shape that hid the request queue for a day).

import { ROLE_DEFAULTS, type SessionRole } from "./roleModel";

/**
 * The ONLY role that may ever be auto-spawned (#3498).
 *
 * `satisfies SessionRole` is load-bearing: if the `debugger` role is renamed or removed, this stops
 * compiling rather than silently becoming a string that matches nothing (which would disable the
 * feature quietly) or, worse, matching a different role.
 */
export const AUTO_SPAWNABLE_ROLE = "debugger" satisfies SessionRole;

/** What the caller wants to auto-spawn, and whether the user has enabled auto-spawn at all. */
export interface AutoSpawnRequest {
  /** The role of the session that WOULD be started. */
  role: SessionRole | null | undefined;
  /** The Settings toggle (`autoSpawnDebugSessions`). Anything but `true` is treated as off. */
  enabled: boolean | null | undefined;
}

/** Allowed, or refused WITH the reason — a refusal must be diagnosable, never a bare `false`. */
export type AutoSpawnDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * THE single authoriser for starting a session automatically (#3498). Every auto-spawn call site must
 * route through this; there is deliberately no other exported way to authorise one.
 *
 * Order matters for the reason text: the setting is checked FIRST so that with auto-spawn off, the
 * refusal says so plainly for every role rather than blaming the role.
 */
export function autoSpawnDecision(req: AutoSpawnRequest): AutoSpawnDecision {
  // Fail-closed: only a literal `true` enables. Undefined/null/missing ⇒ off.
  if (req.enabled !== true) {
    return {
      allowed: false,
      reason: "auto-spawn is disabled — turn it on in Settings → Security (it is off by default)",
    };
  }
  if (req.role !== AUTO_SPAWNABLE_ROLE) {
    return {
      allowed: false,
      reason:
        `only the '${AUTO_SPAWNABLE_ROLE}' session may be auto-spawned; ` +
        `'${req.role ?? "(none)"}' must be started explicitly`,
    };
  }
  return { allowed: true };
}

/** {@link autoSpawnDecision} as a boolean, for call sites that don't surface the reason. */
export function mayAutoSpawn(req: AutoSpawnRequest): boolean {
  return autoSpawnDecision(req).allowed;
}

/**
 * Every role the app defines, at RUNTIME — so the gate's tests enumerate the real union rather than a
 * hand-copied list that would drift the moment a role is added. `ROLE_DEFAULTS` is
 * `Record<SessionRole, …>`, so its keys ARE the union.
 */
export function allSessionRoles(): SessionRole[] {
  return Object.keys(ROLE_DEFAULTS) as SessionRole[];
}
