// RequestSessionsMount (#3498) — the LAUNCHER. Starts one debug session per open `bsc request`, so a
// filed request is worked because it exists rather than waiting in a queue for someone to open a
// session. Mirrors DebugSessionMount's shape (a parked, off-screen TerminalSlot per pane) — this one
// just holds N of them instead of one.
//
// It obeys a plan and decides nothing: `planRequestSpawns` (shared/lib/session/requestSpawn) owns the
// gate, the dedup and the cap. Everything here is mechanics.
//
// ── WHAT MAKES THIS SAFE TO SHIP ────────────────────────────────────────────────────────────────────
//  * It is INERT unless `autoSpawnDebugSessions` is on, and that setting is OFF by default.
//  * The only role it can start is the plan's, which is always `debugger`.
//  * Sessions launch FRESH (`claude`, never `--continue`) with `paneContinue: false` — the #3497 rule,
//    which matters doubly here: each pane is per-request and must never inherit another conversation.
//  * A capped, deduped plan means a flood of requests cannot become a flood of sessions.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { usePoll } from "@/shared/hooks/usePoll";
import { Box } from "@/shared/ui/layout/Box";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { planRequestSpawns, type OpenRequest } from "@/shared/lib/session/requestSpawn";
import { DEBUG_INIT_CMD } from "./DebugSessionMount";
import { requestPaneId, requestCharter } from "./requestSession";

/** How often to look for newly-filed requests. Slow on purpose: a request is not urgent, and a tight
 *  loop would re-plan constantly for no benefit. */
const POLL_MS = 20_000;

/** Max concurrent request sessions. Deliberately small — each is a full Claude session against the
 *  repo, and the point of the cap is that a burst of requests can never become a burst of sessions. */
const CAP = 2;

/**
 * Mounts a live debug session per open request while auto-spawn is on. Renders nothing visible; each
 * terminal is shown by opening its node, exactly like the standing debug session.
 */
export function RequestSessionsMount() {
  const enabled = useAppStore((s) => s.autoSpawnDebugSessions);
  // undefined = still resolving; null = no source tree (a shipped binary — never launch into a missing
  // cwd); string = the repo root these sessions work in.
  const [repoRoot, setRepoRoot] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState<OpenRequest[]>([]);
  // The requests we have already mounted a session for. Kept here (not derived) so a session stays up
  // while its request is still open, and is not re-planned on every poll.
  const [active, setActive] = useState<OpenRequest[]>([]);

  useEffect(() => {
    if (!enabled) { setRepoRoot(undefined); return; }
    let alive = true;
    void safeInvoke<string | null>("debug_repo_root", undefined, null, () => {}).then((root) => {
      if (alive) setRepoRoot(root);
    });
    return () => { alive = false; };
  }, [enabled]);

  // #3522: when the user TURNS auto-spawn on (off→on), review the queue once and drop completed
  // (resolved) requests, so the launcher works a live list rather than a store that only ever grew.
  // Keyed to the TRANSITION, not to being enabled: a persisted-on startup is not "turning it on", and a
  // poll must never re-prune. `bscRun` is fire-and-forget — a missing binary/verb is a silent no-op.
  const prevEnabled = useRef(enabled);
  useEffect(() => {
    const was = prevEnabled.current;
    prevEnabled.current = enabled;
    if (!was && enabled) void bscRun(null, ["request", "prune"]);
  }, [enabled]);

  // Poll the queue. `bscJson` swallows a missing binary/verb and returns the fallback, so a machine
  // without a working `bsc` simply never spawns rather than erroring in a loop.
  usePoll(
    async () => {
      if (!enabled || !repoRoot) return;
      setOpen(await bscJson<OpenRequest[]>(null, ["request", "list", "--open", "--json"], []));
    },
    POLL_MS,
    [enabled, repoRoot],
  );

  // Drop finished work: once a request is no longer open (the session resolved it), release its slot so
  // the cap frees up. This is also what stops a resolved request being re-planned forever.
  useEffect(() => {
    const openIds = new Set(open.map((r) => r.id));
    setActive((prev) => (prev.some((r) => !openIds.has(r.id)) ? prev.filter((r) => openIds.has(r.id)) : prev));
  }, [open]);

  const plan = useMemo(
    () => planRequestSpawns({ requests: open, active, enabled, cap: CAP }),
    [open, active, enabled],
  );

  // Seed each newly-planned session's launch fields, then mark it active so it is not planned twice.
  useEffect(() => {
    if (!plan.spawn.length || !repoRoot) return;
    useAppStore.setState((st) => {
      const prompts = { ...st.paneStartupPromptText };
      const cont = { ...st.paneContinue };
      for (const r of plan.spawn) {
        prompts[requestPaneId(r.id)] = requestCharter(r);
        // #3497: never resume. A per-request pane inheriting another conversation would be strictly
        // worse than the singleton case that bug came from.
        cont[requestPaneId(r.id)] = false;
      }
      return { paneStartupPromptText: prompts, paneContinue: cont };
    });
    setActive((prev) => [...prev, ...plan.spawn]);
  }, [plan, repoRoot]);

  // Publish the live set so the Glance graph can render a node per session (#3498). Without this the
  // sessions run with no node — unopenable, unsupervisable, unstoppable.
  const setActiveRequestSessions = useAppStore((s) => s.setActiveRequestSessions);
  useEffect(() => {
    setActiveRequestSessions(active.map((r) => r.id));
  }, [active, setActiveRequestSessions]);

  if (!enabled || !repoRoot || !active.length) return null;
  return (
    <Box
      aria-hidden
      style={{
        position: "absolute", left: -99999, top: 0, width: 800, height: 600,
        overflow: "hidden", pointerEvents: "none", display: "flex", flexDirection: "column",
      }}
    >
      {active.map((r) => (
        <TerminalSlot
          key={r.id}
          paneId={requestPaneId(r.id)}
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
