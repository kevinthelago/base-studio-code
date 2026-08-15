// RequestSessionsMount (#one-request-one-debug-session) — one debug session per request, bound to it.
//
// Each cycle: CLAIM every open request (atomically, one `bsc request claim` per request), then hold one
// session per claimed request, named for it (`debug-studio:req-<id>`), and close each when ITS request
// resolves. There is no pool, no cap, no pacing and no reaper — see `poolPlan.ts` for what each of those
// was for and why 1:1 removes the need.
//
// WHY THE MOUNT CLAIMS, rather than the session. `bsc request claim` takes the OLDEST open request; it
// cannot be pointed at a specific id. So the only way to bind a session to a KNOWN request is to claim
// first and spawn for whatever came back. That the claim is atomic is what makes this safe beside the
// standing debug session, which self-serves the same queue: whoever claims first holds it, and the other
// simply never sees it as open. No charter change was needed there, and none was made.
//
// It obeys a plan and decides nothing: `planRequestSessions` owns the gate and the reconcile. This mount
// is mechanics — claim, apply the plan (seed each session's charter, close finished ones, publish the
// live ids for the Glance graph).
//
// ── WHAT MAKES THIS SAFE TO SHIP ────────────────────────────────────────────────────────────────────
//  * INERT unless `autoSpawnDebugSessions` is on (off by default); turning it off closes every session.
//  * The only role it can start is the plan's — `debugger` — and every pane is under the
//    `debug-studio:` prefix, so it is full-capability + role-less like the standing session (#3520).
//  * Sessions launch FRESH (`claude`, never `--continue`) with `paneContinue: false` (#3497): each is
//    bound to one request and must never inherit another conversation.
//  * NOT bounded by a cap any more — a deliberate trade, recorded in `poolPlan.ts`. Concurrency is the
//    number of unresolved claimed requests.
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { usePoll } from "@/shared/hooks/usePoll";
import { Box } from "@/shared/ui/layout/Box";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { planRequestSessions, type RequestSession, type RequestRow } from "@/shared/lib/session/poolPlan";
import { requestPaneId, requestIdFromPaneId } from "@/shared/lib/session/requestSpawn";
import { DEBUG_INIT_CMD } from "@/features/debug/DebugSessionMount";
import { requestCharter } from "@/features/debug/requestSession";

/** How often to reconcile against the queue. Slow on purpose: a request is not urgent, and a session
 *  that is already working one is not waiting on this loop. */
const POLL_MS = 20_000;

/** A raw row from `bsc request list --json` (snake_case from the Rust store). */
interface RawRequest {
  id: number;
  status: string;
  claimed_by?: string | null;
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
  // The request sessions this mount tracks (NOT the standing session). Kept in a ref too so the poll
  // reconciles against the latest set without re-subscribing the interval (the ref is synced in an
  // effect, never during render).
  const [sessions, setSessions] = useState<RequestSession[]>([]);
  const sessionsRef = useRef<RequestSession[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

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

  // The reconcile loop, once per poll. `bscJson`/`bscRun` swallow a missing binary or verb and return the
  // fallback, so a machine without a working `bsc` simply never spawns rather than erroring in a loop.
  usePoll(
    async () => {
      if (!enabled || !repoRoot) return;

      // 1 — CLAIM every open request, one atomic claim each, so that by the time the plan runs each has
      // a definite id to be bound to. Bounded by the open count read first, so a request the claim loop
      // itself creates could never spin it.
      //
      // NO `--by`. It stamps the holder at claim time, and the holder here is a pane named FOR the
      // request the claim is about to return — the id is not known until after. Nothing needs the stamp:
      // the binding is the pane name (`requestIdFromPaneId`), which is derived rather than recorded and
      // so cannot go stale. A `null` claim means the queue drained under us (the standing debug session
      // took the last one), which is exactly the race the atomic claim exists to make safe.
      const open = (await bscJson<RawRequest[]>(null, ["request", "list", "--json"], []))
        .filter((r) => r.status === "open");
      for (let i = 0; i < open.length; i += 1) {
        const claimed = await bscJson<RawRequest | null>(null, ["request", "claim", "--json"], null);
        if (!claimed) break;
      }

      // 2 — PLAN + APPLY against the post-claim queue.
      const raw = await bscJson<RawRequest[]>(null, ["request", "list", "--json"], []);
      const requests: RequestRow[] = raw.map((r) => ({ id: r.id, status: r.status, claimedBy: r.claimed_by ?? null }));
      const plan = planRequestSessions({ requests, sessions: sessionsRef.current, enabled });

      // Free the store fields of every closed pane, so a stopped session leaves nothing behind.
      if (plan.close.length) {
        useAppStore.setState((st) => {
          const prompts = { ...st.paneStartupPromptText };
          const cont = { ...st.paneContinue };
          for (const paneId of plan.close) { delete prompts[paneId]; delete cont[paneId]; }
          return { paneStartupPromptText: prompts, paneContinue: cont };
        });
      }

      if (plan.start.length) {
        // Seed the launch fields TerminalView reads: the charter naming THIS request (baked as
        // --initial-message) and paneContinue=false (#3497 — never resume; each session is bound to one
        // request and must not inherit another conversation).
        useAppStore.setState((st) => {
          const prompts = { ...st.paneStartupPromptText };
          const cont = { ...st.paneContinue };
          for (const id of plan.start) {
            prompts[requestPaneId(id)] = requestCharter(id);
            cont[requestPaneId(id)] = false;
          }
          return { paneStartupPromptText: prompts, paneContinue: cont };
        });
      }
      setSessions([...plan.sessions, ...plan.start.map((id) => ({ paneId: requestPaneId(id) }))]);
    },
    POLL_MS,
    [enabled, repoRoot],
  );

  // Publish the live REQUEST IDS so the Glance graph can render a node per request. Without this the
  // sessions run with no node — unopenable, unsupervisable, unstoppable. The published value is now the
  // request id rather than an anonymous slot, which is what lets the node be labelled with the work.
  const setActiveDebugSlots = useAppStore((s) => s.setActiveDebugSlots);
  useEffect(() => {
    setActiveDebugSlots(sessions.map((s) => requestIdFromPaneId(s.paneId)).filter((n): n is number => n != null));
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
