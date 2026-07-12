// Kit-change propagation actuator (#2277). Drains the store's queued kit-change dispatches
// (`kitDispatches`, produced by setComponent's fan-out over the consumer index) and, for each CONSUMER
// project whose per-project auto-dispatch toggle is ON, delivers a bounded, deduped set of BREAKING
// changes to the ONE rail (#2806): a LIVE fleet → the project's director pane (bsc-issue → bsc-assign →
// the UI worker re-runs `bsc ui emit sync`). A consumer with NO live fleet HOLDS in the queue (carried
// forward, adopted on its next launch) — the GitHub-issue rail was dropped. Notify-only by default
// (toggle OFF ⇒ surface-only, rendered by KitChangesCard). The gate/dedup/rate-limit is the pure
// `planKitDrain`; this is the thin poll+deliver layer, mounted once in ConsoleWorkspace beside
// useFaultTriage. It lives in app/console (not shared/) because it reads the app's pane-identity +
// director-drive state.
import { useRef } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { directorPaneId } from "@/app/console/lib/paneIdentity";
import {
  planKitDrain, deliveryKey, kitDispatchPrompt, DEFAULT_KIT_DRAIN,
  type Dispatch, type KitDelivery,
} from "@/features/designs";

// Slow cadence — kit changes aren't a real-time signal, and each tick is pure store reads (no bsc exec).
const POLL_MS = 30_000;

/** Fire one delivery on the only rail (#2806): route into the consumer's LIVE fleet director, which
 *  captures + assigns adoption (bsc-issue → bsc-assign) to the UI worker, who re-runs `bsc ui emit sync`.
 *  `planKitDrain` only emits deliveries for a LIVE consumer, so the director pane is always present. */
async function fireDelivery(del: KitDelivery): Promise<boolean> {
  await injectPrompt(directorPaneId(del.projectKey), kitDispatchPrompt(del.change));
  return true;
}

export function useKitDispatch(): void {
  // (consumer, change) keys already delivered this app run — the dedup ledger, carried across ticks. A
  // delivered change is also dismissed from the queue, so this only guards the async gap between fire and
  // dismiss (and a still-queued change after a failed dismiss).
  const delivered = useRef<Set<string>>(new Set());
  // Deliveries in flight this run, so a slow paste/POST can't be double-fired by the next tick.
  const inFlight = useRef<Set<string>>(new Set());

  usePoll(async (isCancelled) => {
    if (isCancelled()) return;
    const st = useAppStore.getState();
    const dispatches = st.kitDispatches;
    if (dispatches.length === 0) return;

    // Group the queued dispatches by consumer project.
    const byProject = new Map<string, Dispatch[]>();
    for (const d of dispatches) {
      const list = byProject.get(d.projectKey);
      if (list) list.push(d);
      else byProject.set(d.projectKey, [d]);
    }

    for (const [projectKey, projDispatches] of byProject) {
      if (isCancelled()) return;
      // Deliver a dispatch when auto-apply is on, its change has been APPROVED (#2944), or the legacy
      // per-project toggle is on. Gated per-dispatch — a project may hold both approved + still-pending.
      const eligible = projDispatches.filter((d) =>
        st.autoApplyKitChanges || st.approvedChangeIds?.includes(d.change.id) || st.autoKitDispatch?.[projectKey],
      );
      if (eligible.length === 0) continue; // nothing approved for this project yet ⇒ surface-only
      const live = !!st.paneDirectorDrive?.[directorPaneId(projectKey)];
      const plan = planKitDrain(eligible, delivered.current, {
        enabled: true, // gated above per dispatch; the pure fn re-checks but we've filtered already
        live,
        maxPerCycle: DEFAULT_KIT_DRAIN.maxPerCycle,
      });
      for (const del of plan.deliver) {
        const key = deliveryKey(del.projectKey, del.change.id);
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        void fireDelivery(del)
          .then((landed) => {
            if (!landed) return; // reserved for a future non-landing rail; today assign always lands
            delivered.current.add(key);
            useAppStore.getState().dismissKitDispatch(del.projectKey, del.change.id);
          })
          .catch(() => {}) // best-effort; a throw leaves it queued to retry next cycle
          .finally(() => inFlight.current.delete(key));
      }
    }
  }, POLL_MS, []);
}
