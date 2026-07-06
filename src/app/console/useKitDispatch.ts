// Kit-change propagation actuator (#2277). Drains the store's queued kit-change dispatches
// (`kitDispatches`, produced by setComponent's fan-out over the consumer index) and, for each CONSUMER
// project whose per-project auto-dispatch toggle is ON, delivers a bounded, deduped set of BREAKING
// changes to a rail: a LIVE fleet → the project's director pane (bsc-issue → bsc-assign); NO live fleet →
// a plain kit-update GitHub issue in the consumer repo. Notify-only by default (toggle OFF ⇒ surface-only,
// rendered by KitChangesCard). The gate/dedup/rate-limit is the pure `planKitDrain`; this is the thin
// poll+deliver layer, mounted once in ConsoleWorkspace beside useFaultTriage. It lives in app/console (not
// shared/) because it reads the app's pane-identity + director-drive + GitHub-token state.
import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { directorPaneId } from "@/app/console/lib/paneIdentity";
import type { AppStore } from "@/store/types";
import {
  planKitDrain, deliveryKey, kitDispatchPrompt, kitUpdateIssue, DEFAULT_KIT_DRAIN,
  type Dispatch, type KitDelivery,
} from "@/features/components";

// Slow cadence — kit changes aren't a real-time signal, and each tick is pure store reads (no bsc exec).
const POLL_MS = 30_000;

/** Fire one delivery to its rail. Returns true only when it actually landed, so a skipped delivery
 *  (issue rail with no repo/token) is NOT marked delivered and stays surface-only until it can land. */
async function fireDelivery(del: KitDelivery, st: AppStore): Promise<boolean> {
  if (del.rail === "assign") {
    // Live fleet: route into the director, which captures + assigns adoption via bsc-issue → bsc-assign.
    await injectPrompt(directorPaneId(del.projectKey), kitDispatchPrompt(del.change));
    return true;
  }
  // Issue rail: open a kit-update issue in the consumer's primary repo. No repo/token ⇒ nowhere to open
  // one — leave it queued (surface-only) rather than dropping it.
  const repo = st.projectLocalRepos[del.projectKey]?.[0];
  const token = st.githubToken;
  if (!repo || !token) return false;
  const { title, body } = kitUpdateIssue(del.change);
  // Raw invoke (not safeInvoke) so a failed POST throws → the delivery isn't marked done and retries.
  await invoke("github_post", { token, path: `repos/${repo}/issues`, body: { title, body, labels: ["kit-update"] } });
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
      if (!st.autoKitDispatch?.[projectKey]) continue; // toggle OFF ⇒ surface-only (no dispatch)
      const live = !!st.paneDirectorDrive?.[directorPaneId(projectKey)];
      const plan = planKitDrain(projDispatches, delivered.current, {
        enabled: true, // gated above per project; the pure fn re-checks but we've filtered already
        live,
        maxPerCycle: DEFAULT_KIT_DRAIN.maxPerCycle,
      });
      for (const del of plan.deliver) {
        const key = deliveryKey(del.projectKey, del.change.id);
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        void fireDelivery(del, st)
          .then((landed) => {
            if (!landed) return; // couldn't deliver (no repo/token) — leave queued, don't mark delivered
            delivered.current.add(key);
            useAppStore.getState().dismissKitDispatch(del.projectKey, del.change.id);
          })
          .catch(() => {}) // best-effort; a throw leaves it queued to retry next cycle
          .finally(() => inFlight.current.delete(key));
      }
    }
  }, POLL_MS, []);
}
