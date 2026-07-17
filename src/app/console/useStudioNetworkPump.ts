// The studio-network pump (#2940): drives the app-owned studio-session network so a `bsc-commission`
// emitted by one session (the planner, or the designer) is fulfilled by another (designer/librarian)
// and the authored artifact id is delivered back — all while the user stays in the planning surface.
//
// Two actuations, both re-derived from the FULL coord log every tick (restart-safe), guarded so each
// message injects exactly once:
//   1. AUTHOR TASK  — an open commission's spec → the TARGET studio pane, once the target has been
//      reachable for the settle window (the lazy-mount host has had time to launch the session; Claude
//      queues input typed mid-boot). Pure decision: studioNetworkDrive.authorInjections.
//   2. DELIVER-BACK — a `deliver`-stamped commission's artifact id → the REQUESTER's pane (a live
//      session). Pure decision: studioNetworkDrive.deliverBackInjections.
//
// REACHABILITY is on-demand: the pump publishes `activeStudioTargets` (targets with open commissions)
// to the store; ConsoleWorkspace's <StudioNetworkHosts> lazy-mounts each target's terminal (launching
// the session) and unmounts it when the list empties (ending the session). No idle studio sessions.
//
// Mounted once in ConsoleWorkspace (stays mounted across screens). Pure logic lives in
// studioNetworkDrive.ts; this is the thin Tauri/React actuator, like useDirectorPump.
import { useRef } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import {
  activeTargets, authorInjections, deliverBackInjections,
  type StudioTarget,
} from "@/shared/lib/fleet/studioNetworkDrive";

const POLL_MS = 1000;
// How long after a target first becomes active before the pump injects its author task — enough for
// the lazy-mount host to run `pty_create` + start Claude. Claude queues input typed mid-turn, so a
// slightly-early inject is buffered rather than lost; this just avoids writing to a not-yet-open pty.
const SETTLE_MS = 3000;

function sameSet(a: StudioTarget[], b: StudioTarget[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

export function useStudioNetworkPump(): void {
  // target → ms epoch when the pump first saw it active (the settle clock). Pruned when it goes idle.
  const activatedAt = useRef<Partial<Record<StudioTarget, number>>>({});
  // Once-guards: author:<id> and deliver:<id> keys already injected. Pruned when the commission is
  // gone from the log so a genuinely new commission with a reused id could re-surface (defensive).
  const injected = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);

  usePoll(async (isCancelled) => {
    if (isCancelled() || inFlight.current) return;
    const res = await readCoordState(2000);
    if (isCancelled() || !res) return;
    const commissions = res.state.commissions;
    const now = Date.now();

    // 1) Publish the reachable set (drives the lazy-mount hosts) + maintain the settle clock.
    const active = activeTargets(commissions);
    for (const t of active) if (activatedAt.current[t] === undefined) activatedAt.current[t] = now;
    for (const t of Object.keys(activatedAt.current) as StudioTarget[]) {
      if (!active.includes(t)) delete activatedAt.current[t];
    }
    const store = useAppStore.getState();
    if (!sameSet(store.activeStudioTargets, active)) store.setActiveStudioTargets(active);

    // Prune once-guards for commissions no longer in the log.
    const liveKeys = new Set(commissions.flatMap((c) => [`author:${c.id}`, `deliver:${c.id}`]));
    for (const k of [...injected.current]) if (!liveKeys.has(k)) injected.current.delete(k);

    // 2) Compute + perform the due injections (author tasks + deliver-backs), each once.
    const due = [
      ...authorInjections(commissions, activatedAt.current, now, SETTLE_MS, injected.current),
      ...deliverBackInjections(commissions, injected.current),
    ];
    if (due.length === 0) return;
    inFlight.current = true;
    try {
      for (const inj of due) {
        if (isCancelled()) break;
        await injectPrompt(inj.paneId, inj.prompt);
        injected.current.add(inj.key);
      }
    } finally {
      inFlight.current = false;
    }
  }, POLL_MS);
}
