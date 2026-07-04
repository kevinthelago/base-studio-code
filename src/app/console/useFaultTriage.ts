// The runtime fault-fix loop actuator (#2265, part of #2258). Polls each live project's runtime-fault
// store (`bsc errors list --unresolved --json`, the errordb #2260) on a slow cadence and, when the
// per-project auto-triage toggle is ON, routes a bounded, deduped set of fixes into that project's
// DIRECTOR pane — which captures + assigns each via the existing coordination emitters (bsc-issue →
// bsc-assign) and resolves it on land. The gate/dedup/rate-limit decisions are the pure
// `planFaultDispatch` (shared/lib/fleet/faultTriage.ts); this is the thin Tauri/React poll+inject layer,
// mounted once in ConsoleWorkspace (stays mounted across screens) beside useDirectorPump / useCoordinator.
// It lives in app/console (not shared/) because it reads the app's pane-identity + director-drive state.
//
// Projects with the toggle OFF (the default) are SURFACE-ONLY here — nothing is dispatched; the fault
// count still shows on the Glance node (useGlanceFaults). A project with no live director pane is also
// effectively surface-only (there's nowhere to route), which is the correct degrade.
import { useRef } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { parsePaneIdentity } from "@/app/console/lib/paneIdentity";
import {
  planFaultDispatch,
  faultDispatchPrompt,
  DEFAULT_FAULT_TRIAGE,
  type FaultLite,
  type FaultLevel,
} from "@/shared/lib/fleet/faultTriage";

// Slow cadence — runtime faults are not a real-time signal and each tick is one `bsc` exec per live
// director. 30s keeps the loop responsive without adding noticeable load.
const POLL_MS = 30_000;

/** The errordb `Fault` JSON row shape (snake_case, as serde emits) the CLI returns. */
interface FaultRow {
  fingerprint: string;
  level: string;
  title: string;
  count: number;
  resolved_at?: number | null;
}

const asLevel = (l: string): FaultLevel => (l === "warn" || l === "fatal" ? l : "error");

function toFaultLite(rows: FaultRow[]): FaultLite[] {
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    level: asLevel(r.level),
    title: r.title,
    count: r.count,
    resolvedAt: r.resolved_at ?? null,
  }));
}

export function useFaultTriage(): void {
  // Per-project dedup ledger (fingerprints already routed), carried across ticks. In-memory per app run
  // — a restart re-reads the fault list and may re-route a still-open fault once, which is acceptable
  // (the director de-dups a duplicate assignment, and the fan-out cap bounds it).
  const dispatched = useRef<Map<string, string[]>>(new Map());
  // Panes with an inject in flight this tick, so a slow paste can't overlap the next tick's.
  const inFlight = useRef<Set<string>>(new Set());

  usePoll(async (isCancelled) => {
    if (isCancelled()) return;
    const st = useAppStore.getState();
    const autoTriage = st.autoTriage ?? {};
    // Live directors: the panes launched with a director drive (same source useDirectorPump reads). Each
    // id parses to a `<projectKey>:director` identity → the project whose faults it owns.
    const directorPanes = Object.keys(st.paneDirectorDrive ?? {});
    if (directorPanes.length === 0) return;

    for (const paneId of directorPanes) {
      if (isCancelled()) return;
      if (inFlight.current.has(paneId)) continue;
      const parsed = parsePaneIdentity(paneId);
      const key = parsed?.kind === "director" ? parsed.projectKey : undefined;
      if (!key) continue;
      if (!autoTriage[key]) continue; // toggle OFF ⇒ surface-only (no dispatch)

      const rows = await bscJson<FaultRow[]>(key, ["errors", "list", "--unresolved", "--json"], []);
      if (isCancelled()) return;
      const faults = toFaultLite(rows);
      const plan = planFaultDispatch(faults, dispatched.current.get(key) ?? [], {
        enabled: true, // gated above per key; the pure fn re-checks but we've filtered already
        ...DEFAULT_FAULT_TRIAGE,
      });
      dispatched.current.set(key, plan.nextDispatched);
      if (plan.dispatch.length === 0) continue;

      inFlight.current.add(paneId);
      void injectPrompt(paneId, faultDispatchPrompt(plan.dispatch))
        .catch(() => {})
        .finally(() => inFlight.current.delete(paneId));
    }
  }, POLL_MS, []);
}
