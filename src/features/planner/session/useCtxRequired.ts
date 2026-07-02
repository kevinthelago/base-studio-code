// useCtxRequired (#1775, extracted from Planning.tsx) — the dynamic Context required-set
// (#1019/#1028): polled from plan.db, baseline-seeded once per project/session. The Context gate
// reads it; context files gate on GENERATION (the file exists), not confirmation, so there's
// nothing to confirm/mirror. Returns the live required-topic list.
import { useState, useEffect, useRef } from "react";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { DISCOVERY_BASELINE } from "../stages/planStageDerive";
import type { BlueprintStage } from "../stages/blueprints";

export function useCtxRequired(effectiveProjectId: string, planSecs: BlueprintStage[]): string[] {
  const [ctxRequired, setCtxRequired] = useState<string[]>([]);
  const ctxRequiredJsonRef = useRef<string>("");
  const ctxSeededRef = useRef<Set<string>>(new Set());

  // #1019: clear the cached manifest on a project switch so a stale set never bleeds across.
  useEffect(() => { setCtxRequired([]); ctxRequiredJsonRef.current = ""; }, [effectiveProjectId]);

  // #1028: poll the Context required-set from plan.db and seed the baseline once per project. The
  // gate reads it to check each required topic's `context/<topic>.md` exists.
  useEffect(() => {
    if (!effectiveProjectId) return;
    let alive = true;
    const tick = async () => {
      try {
        // `bsc plan discovery list --json` emits the required-topic string array (the same `Vec<String>`
        // the old `plan_list_discovery` command returned); bscJson degrades to [] when plan.db is absent.
        const m = await bscJson<string[]>(effectiveProjectId, ["plan", "discovery", "list", "--json"], []);
        if (!alive) return;
        // Seed the baseline once per project/session if the set is empty — a deterministic floor before
        // the planner runs `bsc-plan context require`. The blueprint's context section `requires`
        // overrides the universal baseline (blueprint seeding).
        if ((m?.length ?? 0) === 0 && !ctxSeededRef.current.has(effectiveProjectId)) {
          ctxSeededRef.current.add(effectiveProjectId);
          const requires = planSecs.find(s => s.key === "discovery")?.requires ?? DISCOVERY_BASELINE;
          for (const t of requires) {
            await bscRun(effectiveProjectId, ["plan", "discovery", "require", t]);
          }
          return; // next tick reads the seeded set
        }
        const j = JSON.stringify(m ?? []);
        if (j !== ctxRequiredJsonRef.current) {
          ctxRequiredJsonRef.current = j;
          setCtxRequired(m ?? []);
        }
      } catch { /* plan.db not created until the planner/seed touches context — ignore */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [effectiveProjectId, planSecs]);

  return ctxRequired;
}
