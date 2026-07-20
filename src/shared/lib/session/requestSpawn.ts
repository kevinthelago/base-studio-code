// The request → session SPAWN POLICY (#3498) — decides WHICH open requests get a session, and says
// out loud why each of the others does not.
//
// ⚠️ NAMING: "plan" here means the spawn DECISION. It has nothing to do with the `planner` session
// role. NO planner session — and no designer, librarian, architect, curator or worker session — is
// ever auto-spawned. The only auto-spawnable role is `debugger`, and this module cannot express any
// other: it does not take a role, it hardcodes {@link AUTO_SPAWNABLE_ROLE} and stamps it on the plan.
//
// This is the bounding layer of auto-spawn, kept PURE and separate from anything that actually starts a
// session. Every rule that limits blast radius lives here — the gate, dedup, the concurrency cap — so
// they are exhaustively testable without launching anything. The launcher's only job is to obey a plan.
//
// ── WHY EVERY SKIP CARRIES A REASON ─────────────────────────────────────────────────────────────────
// The failure mode this whole feature exists to remove is silent non-work: a request filed, nothing
// happening, and no signal anywhere (the queue sat unread for a day because the one consumer was
// broken — #3497). A planner that silently returned fewer items would recreate exactly that. So a
// request is never dropped; it is either spawned or skipped WITH a reason, and the caller can surface
// the skips.
//
// ── THE GATE IS RE-APPLIED HERE, NOT ASSUMED ────────────────────────────────────────────────────────
// `autoSpawnDecision` is consulted by this planner even though the caller is also expected to respect
// it. Defence in depth is deliberate for a capability this consequential: a caller that forgets the
// check still cannot get a plan that spawns anything.

import { autoSpawnDecision, AUTO_SPAWNABLE_ROLE } from "./autoSpawn";
import type { SessionRole } from "./roleModel";

/** The PANE id for a request's session — per-request, so two requests never share a conversation. */
export function requestPaneId(id: number): string {
  return `debug-studio:req-${id}`;
}

/** The GRAPH node id for a request's session. Distinct from the pane id because the Studio Network's
 *  node ids are team-position ids; {@link requestIdFromNodeId} is the inverse the graph uses to resolve
 *  a node back to its pane. Lives here (shared) because both `features/teams` and `features/glance`
 *  need it and neither may reach into the other. */
export function requestNodeId(id: number): string {
  return `debugger-req-${id}`;
}

/** The request id behind a graph node, or null when the node is not a request session. */
export function requestIdFromNodeId(nodeId: string): number | null {
  const m = /^debugger-req-(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

/** One open improvement request, as `bsc request list --open --json` returns it. */
export interface OpenRequest {
  id: number;
  /** The tool surface the request is about (`bsc ui`, `bsc graph`, …) — the routing key. */
  surface: string;
  /** The exact command that failed, when the request cites one. */
  cmd?: string | null;
  text: string;
}

export interface SpawnPlanInput {
  /** The open requests. Order-insensitive — the planner works them oldest-id-first for fairness. */
  requests: OpenRequest[];
  /** Request ids that ALREADY have a session working them, so they are never spawned twice. */
  active: OpenRequest[];
  /** The Settings toggle (`autoSpawnDebugSessions`). Anything but `true` is off. */
  enabled: boolean | null | undefined;
  /** Maximum concurrent request sessions, INCLUDING the active ones. */
  cap: number;
}

export interface SkippedRequest {
  request: OpenRequest;
  reason: string;
}

export interface SpawnPlan {
  /** The role every session in {@link spawn} must be launched as. Always {@link AUTO_SPAWNABLE_ROLE}
   *  (`debugger`) — carried on the plan so the launcher READS the role rather than choosing one. A
   *  launcher that ignores this and starts some other role is then an obvious defect at the call site,
   *  not an invisible assumption. */
  role: SessionRole;
  /** Requests to start a session for, oldest first. */
  spawn: OpenRequest[];
  /** Everything not spawned, each with why — never a silent drop. */
  skipped: SkippedRequest[];
}

/**
 * The dedup key: a request is "the same work" as another when it names the same surface AND the same
 * failing command. Falls back to the TEXT when no command is cited, so an identical re-file still
 * collapses.
 *
 * KNOWN LIMIT, stated rather than hidden: a re-filed request whose prose was REWORDED does not collapse
 * (the designer filed the same report three times while fighting #3483, each time reworded to dodge the
 * deny hook). Those would plan as distinct work. The cap is what bounds that case, not the dedup.
 */
function dedupeKey(r: OpenRequest): string {
  const cmd = (r.cmd ?? "").trim();
  return `${r.surface.trim()}\u0000${cmd || r.text.trim()}`;
}

/**
 * Plan which open requests should get a session (#3498). Pure — it starts nothing.
 *
 * Rules, in order:
 *  1. **The gate.** If auto-spawn is off, NOTHING is spawned and every request is skipped with the
 *     gate's own reason. (Checked against {@link AUTO_SPAWNABLE_ROLE}, the only auto-spawnable role.)
 *  2. **Already working.** A request with a live session is skipped.
 *  3. **Duplicate work.** A request whose {@link dedupeKey} matches an active session, or an
 *     earlier request in this same plan, is skipped.
 *  4. **The cap.** At most `cap` sessions exist at once, counting the active ones; the remainder is
 *     skipped rather than queued invisibly.
 *
 * Oldest id first, so the queue drains in the order it was filed rather than newest-wins.
 */
export function planRequestSpawns(input: SpawnPlanInput): SpawnPlan {
  const ordered = [...input.requests].sort((a, b) => a.id - b.id);

  // 1 · the gate — one refusal, applied to everything, carrying its own reason.
  const gate = autoSpawnDecision({ role: AUTO_SPAWNABLE_ROLE, enabled: input.enabled });
  if (!gate.allowed) {
    return {
      role: AUTO_SPAWNABLE_ROLE,
      spawn: [],
      skipped: ordered.map((request) => ({ request, reason: gate.reason })),
    };
  }

  const activeIds = new Set(input.active.map((r) => r.id));
  const takenKeys = new Set(input.active.map(dedupeKey));
  const cap = Number.isFinite(input.cap) ? Math.max(0, Math.trunc(input.cap)) : 0;
  let room = Math.max(0, cap - input.active.length);

  const spawn: OpenRequest[] = [];
  const skipped: SkippedRequest[] = [];

  for (const request of ordered) {
    if (activeIds.has(request.id)) {
      skipped.push({ request, reason: `request #${request.id} already has a session working it` });
      continue;
    }
    const key = dedupeKey(request);
    if (takenKeys.has(key)) {
      skipped.push({
        request,
        reason: `duplicate work — the same '${request.surface}' command is already being worked`,
      });
      continue;
    }
    if (room <= 0) {
      skipped.push({
        request,
        reason: `at the concurrency cap (${cap}) — it will be planned once a session finishes`,
      });
      continue;
    }
    spawn.push(request);
    takenKeys.add(key);
    room -= 1;
  }

  return { role: AUTO_SPAWNABLE_ROLE, spawn, skipped };
}
