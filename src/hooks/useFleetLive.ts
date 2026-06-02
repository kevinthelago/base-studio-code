// Live Fleet view model (#412). Reads the running fleet from the store
// (`fleetPaneStreams` roster + live `paneStatus`) and polls the coordination log
// (`read_coord_log` → `ingestCoordLog`) for blocked/asking/waiting, then assembles
// the worker roster via the pure mappers in lib/fleetLive.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ingestCoordLog, emptyCoordState, type CoordState } from "../lib/coordination";
import { buildLiveWorkers, deriveFleetKpis, statusCounts, type LiveWorker, type FleetKpis } from "../lib/fleetLive";

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
  const [coord, setCoord] = useState<CoordState>(emptyCoordState());
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const lines = await invoke<string[]>("read_coord_log", { limit: 1000 }).catch(() => [] as string[]);
      if (cancelled) return;
      setCoord(ingestCoordLog(lines ?? [], emptyCoordState()).state);
    };
    load();
    const id = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const workers = useMemo(
    () => buildLiveWorkers({ fleetPaneStreams, paneStatus, coord, tabCount: tabs.length, disabledPanes, profiles }),
    [fleetPaneStreams, paneStatus, coord, tabs.length, disabledPanes, profiles],
  );
  const kpis = useMemo(() => deriveFleetKpis(workers), [workers]);
  const counts = useMemo(() => statusCounts(workers), [workers]);

  return { workers, kpis, counts, hasFleet: workers.length > 0 };
}
