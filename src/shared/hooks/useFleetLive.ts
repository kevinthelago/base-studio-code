// Live Fleet view model (#412). Reads the running fleet from the store
// (`fleetPaneStreams` roster + live `paneStatus`) and polls the coordination log
// (`read_coord_log` → `ingestCoordLog`) for blocked/asking/waiting, then assembles
// the worker roster via the pure mappers in lib/fleetLive.
import { useMemo } from "react";
import { useAppStore } from "@/store";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { buildLiveWorkers, deriveFleetKpis, statusCounts, type LiveWorker, type FleetKpis } from "@/shared/lib/fleet/fleetLive";

export interface UseFleetLive {
  workers: LiveWorker[];
  kpis: FleetKpis;
  counts: Partial<Record<LiveWorker["status"], number>>;
  hasFleet: boolean;
}

export function useFleetLive(): UseFleetLive {
  const fleetPaneStreams = useAppStore(s => s.fleetPaneStreams);
  const paneStatus       = useAppStore(s => s.paneStatus);
  const tabs             = useAppStore(s => s.tabs);
  const disabledPanes    = useAppStore(s => s.disabledPanes);
  const profiles         = useAppStore(s => s.agentProfiles);

  // The coordination log is the fleet's own activity feed (blocked/asking/waiting,
  // landed/merged). Polled while the screen is mounted — no store wiring needed.
  const { state: coord } = useCoordLog({ limit: 1000, ms: 4000 });

  const workers = useMemo(
    () => buildLiveWorkers({ fleetPaneStreams, paneStatus, coord, tabCount: tabs.length, disabledPanes, profiles }),
    [fleetPaneStreams, paneStatus, coord, tabs.length, disabledPanes, profiles],
  );
  const kpis = useMemo(() => deriveFleetKpis(workers), [workers]);
  const counts = useMemo(() => statusCounts(workers), [workers]);

  return { workers, kpis, counts, hasFleet: workers.length > 0 };
}
