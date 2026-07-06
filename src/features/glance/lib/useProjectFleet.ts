// useProjectFleet (#…) — load a project's fleet plan straight from ITS plan.db. The `bsc` bridge scopes
// $BSC_PLAN_DB by the project key, so this reads the SAME `bsc plan fleet get --full --json` blob the
// planner poll reads — but for ANY project, not just the active one the store's `planFleet` mirrors. That
// is what makes the Glance drill show a project's REAL fleet instead of the sample. Returns null while
// loading and when a project has no planned fleet. Parsed via the shared `parseFleetFile`.
import { useEffect, useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { parseFleetFile, type FleetPlan } from "@/features/planner/fleet/planFleet";

export function useProjectFleet(projectKey: string | null): FleetPlan | null {
  // Store the loaded fleet WITH the key it's for, so a cleared/changed drill just returns null (no
  // stale fleet, no synchronous setState-in-effect reset).
  const [loaded, setLoaded] = useState<{ key: string; fleet: FleetPlan | null }>({ key: "", fleet: null });
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    bscJson<unknown | null>(projectKey, ["plan", "fleet", "get", "--full", "--json"], null)
      .then((raw) => { if (!cancelled) setLoaded({ key: projectKey, fleet: raw ? parseFleetFile(JSON.stringify(raw)) : null }); })
      .catch(() => { if (!cancelled) setLoaded({ key: projectKey, fleet: null }); });
    return () => { cancelled = true; };
  }, [projectKey]);
  return projectKey && loaded.key === projectKey ? loaded.fleet : null;
}
