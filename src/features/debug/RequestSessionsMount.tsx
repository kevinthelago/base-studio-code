// RequestSessionsMount (#3535) — the OVERFLOW POOL manager. The standing debug session
// (`DebugSessionMount`) is the always-on primary that self-serves the request queue; this mount sizes the
// overflow beside it: when the pool is busy and there is more CLAIMABLE work it spins up ONE more
// generic-charter debugger, paced (one warming at a time) and hard-capped, and CLOSES each session when
// its claimed request resolves.
//
// It obeys a plan and decides nothing: `planPool` (shared/lib/session/poolPlan) owns the gate, the
// pacing, the cap and the reap. This mount is mechanics — poll the queue, apply the plan (seed a new
// session's charter, close finished ones, publish the live slots for the Glance graph), and LOG when the
// pool is at capacity with work still waiting (#3535).
//
// ── WHAT MAKES THIS SAFE TO SHIP ────────────────────────────────────────────────────────────────────
//  * INERT unless `autoSpawnDebugSessions` is on (off by default); turning it off closes every overflow.
//  * The only role it can start is the plan's — `debugger` — and every pool pane is under the
//    `debug-studio:` prefix, so it is full-capability + role-less like the standing session (#3520).
//  * Sessions launch FRESH (`claude`, never `--continue`) with `paneContinue: false` (#3497): each is
//    generic and must never inherit another conversation.
//  * Bounded: overflow is capped at POOL_CAP - 1, so a never-resolving request can't fill the machine.
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { usePoll } from "@/shared/hooks/usePoll";
import { log } from "@/shared/lib/core/log";
import { Box } from "@/shared/ui/layout/Box";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { planPool, type PoolSession, type RequestRow } from "@/shared/lib/session/poolPlan";
import { poolPaneId, poolSlotFromPaneId } from "@/shared/lib/session/requestSpawn";
import { DEBUG_INIT_CMD } from "./DebugSessionMount";
import { poolCharter } from "./requestSession";

/** How often to reconcile the pool against the queue. Slow on purpose: a request is not urgent, and this
 *  is also the cadence `pollsWarming` advances at (`poolPlan.MAX_WARM_POLLS` × this ≈ the warm-out grace). */
const POLL_MS = 20_000;

/** Max TOTAL concurrent debuggers INCLUDING the always-on standing session — so overflow is capped at
 *  POOL_CAP - 1. Three is the deliberate starting point (#3535): the standing session + up to two
 *  overflow. A never-resolving request must never be able to fill the machine with debuggers. */
const POOL_CAP = 3;

/** A raw row from `bsc request list --json` (snake_case from the Rust store). */
interface RawRequest {
  id: number;
  status: string;
  claimed_by?: string | null;
}

/** The lowest slot index not used by any kept session — so slots are reused as sessions come and go. */
function lowestFreeSlot(sessions: PoolSession[]): number {
  const used = new Set(sessions.map((s) => poolSlotFromPaneId(s.paneId)).filter((n): n is number => n != null));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

/**
 * Mounts the overflow debugger pool while auto-spawn is on. Renders nothing visible; each session's
 * terminal is shown by opening its Glance node, exactly like the standing debug session.
 */
export function RequestSessionsMount() {
  const enabled = useAppStore((s) => s.autoSpawnDebugSessions);
  // undefined = still resolving; null = no source tree (shipped binary — never launch into a missing
  // cwd); string = the repo root these sessions work in.
  const [repoRoot, setRepoRoot] = useState<string | null | undefined>(undefined);
  // The overflow sessions this pool tracks (NOT the standing session). Kept in a ref too so the poll
  // reconciles against the latest set without re-subscribing the interval (the ref is synced in an
  // effect, never during render).
  const [sessions, setSessions] = useState<PoolSession[]>([]);
  const sessionsRef = useRef<PoolSession[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  // Throttles the capacity-pressure log to the TRANSITION into at-capacity, not every 20s poll.
  const atCapRef = useRef(false);

  useEffect(() => {
    if (!enabled) { setRepoRoot(undefined); return; }
    let alive = true;
    void safeInvoke<string | null>("debug_repo_root", undefined, null, () => {}).then((root) => {
      if (alive) setRepoRoot(root);
    });
    return () => { alive = false; };
  }, [enabled]);

  // #3522: when the user TURNS auto-spawn on (off→on), review the queue once and drop completed (resolved)
  // requests. Keyed to the transition, never a poll; `bscRun` is fire-and-forget (a missing binary is a
  // no-op).
  const prevEnabled = useRef(enabled);
  useEffect(() => {
    const was = prevEnabled.current;
    prevEnabled.current = enabled;
    if (!was && enabled) void bscRun(null, ["request", "prune"]);
  }, [enabled]);

  // The reconcile loop: ONE planPool per poll (so `pollsWarming` advances once per cycle, not per render).
  // `bscJson` swallows a missing binary/verb and returns the fallback, so a machine without a working
  // `bsc` simply never spawns rather than erroring in a loop.
  usePoll(
    async () => {
      if (!enabled || !repoRoot) return;
      const raw = await bscJson<RawRequest[]>(null, ["request", "list", "--json"], []);
      const requests: RequestRow[] = raw.map((r) => ({ id: r.id, status: r.status, claimedBy: r.claimed_by ?? null }));
      const plan = planPool({ requests, sessions: sessionsRef.current, enabled, cap: POOL_CAP });

      // Capacity pressure (#3535): log only on the transition INTO at-capacity, so it's a signal, not spam.
      if (plan.atCapacity && !atCapRef.current) {
        log.warn(
          `debug pool at capacity (${POOL_CAP} incl. the standing session) — ${plan.waiting} request(s) waiting for a free session`,
          "debug",
        );
      }
      atCapRef.current = plan.atCapacity;

      // Free the store fields of every closed pane, so a stopped slot leaves nothing behind.
      if (plan.close.length) {
        useAppStore.setState((st) => {
          const prompts = { ...st.paneStartupPromptText };
          const cont = { ...st.paneContinue };
          for (const paneId of plan.close) { delete prompts[paneId]; delete cont[paneId]; }
          return { paneStartupPromptText: prompts, paneContinue: cont };
        });
      }

      let next = plan.sessions;
      if (plan.spawn) {
        const paneId = poolPaneId(lowestFreeSlot(next));
        // Seed the launch fields TerminalView reads: the generic charter (baked as --initial-message) and
        // paneContinue=false (#3497 — never resume; each pool session is generic and fresh).
        useAppStore.setState((st) => ({
          paneStartupPromptText: { ...st.paneStartupPromptText, [paneId]: poolCharter() },
          paneContinue: { ...st.paneContinue, [paneId]: false },
        }));
        next = [...next, { paneId, claimedId: null, pollsWarming: 0 }];
      }
      setSessions(next);
    },
    POLL_MS,
    [enabled, repoRoot],
  );

  // Publish the live slots so the Glance graph can render a node per overflow session (#3535). Without
  // this the sessions run with no node — unopenable, unsupervisable, unstoppable.
  const setActiveDebugSlots = useAppStore((s) => s.setActiveDebugSlots);
  useEffect(() => {
    setActiveDebugSlots(sessions.map((s) => poolSlotFromPaneId(s.paneId)).filter((n): n is number => n != null));
  }, [sessions, setActiveDebugSlots]);

  if (!enabled || !repoRoot || !sessions.length) return null;
  return (
    <Box
      aria-hidden
      style={{
        position: "absolute", left: -99999, top: 0, width: 800, height: 600,
        overflow: "hidden", pointerEvents: "none", display: "flex", flexDirection: "column",
      }}
    >
      {sessions.map((s) => (
        <TerminalSlot
          key={s.paneId}
          paneId={s.paneId}
          primary
          parked
          visible={false}
          initialCwd={repoRoot}
          initCmd={DEBUG_INIT_CMD}
        />
      ))}
    </Box>
  );
}
