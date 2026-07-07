// planBoardProjection (#2498) — the pure builder behind the `plan` store_state domain: the
// stage/gate board the mobile Planner page renders. COMPLEMENTS the existing `plan_state`
// frame (files + transcript, usePlannerTunnelSync) rather than duplicating it: this payload
// carries the DERIVED board — the focused-pane stage list with per-stage status + unmet gate
// reasons (the same `stagesFrom` output the desktop stepper renders), confirmed/skipped sets,
// the fleet streams, and the deploy/market summaries. Pure (no React/Tauri) so the shape is
// unit-testable from fixtures.

import type { Stage } from "../stages/focusedPlan";
import type { FleetPlan } from "../fleet/planFleet";
import { deploymentDefined, type DeployConfig } from "../lib/deployConfig";
import { marketDefined, type MarketConfig } from "../lib/marketConfig";

export interface PlanBoardStage {
  key: string;
  name: string;
  glyph: string;
  status: Stage["status"];
  /** Gate fill 0..1. */
  fraction: number;
  optional?: boolean;
  /** The still-unmet gate requirements (empty once the gate passes). */
  unmet: { label: string; detail?: string }[];
}

export interface PlanBoardStream {
  id: string;
  name: string;
  repo: string;
  issues: number;
  dependsOn: string[];
  persona?: string;
}

export interface PlanBoardPayload {
  projectId: string;
  title: string;
  currentStage: string;
  /** "complete" | "in_progress" | "starting" — the same label plan_status carries. */
  statusLabel: string;
  /** The active stage's gate passed — the user-only confirm is what advances it. */
  gateReady: boolean;
  planComplete: boolean;
  stages: PlanBoardStage[];
  confirmed: string[];
  skipped: string[];
  streams: PlanBoardStream[];
  directorEnabled: boolean;
  deploy: { defined: boolean; services: { id: string; repo: string; platform: string; workload: string }[] };
  market: { defined: boolean; summary: string; recommendation?: string };
}

export function buildPlanBoardPayload(input: {
  projectId: string;
  title: string;
  currentStage: string;
  statusLabel: string;
  gateReady: boolean;
  planComplete: boolean;
  stages: Stage[];
  confirmed: ReadonlySet<string> | string[];
  skipped: ReadonlySet<string> | string[];
  fleet?: FleetPlan;
  deploy?: DeployConfig;
  market?: MarketConfig;
}): PlanBoardPayload {
  return {
    projectId: input.projectId,
    title: input.title,
    currentStage: input.currentStage,
    statusLabel: input.statusLabel,
    gateReady: input.gateReady,
    planComplete: input.planComplete,
    stages: input.stages.map((s) => ({
      key: s.key, name: s.name, glyph: s.glyph, status: s.status,
      fraction: s.fraction, optional: s.optional, unmet: s.unmet ?? [],
    })),
    confirmed: [...input.confirmed].sort(),
    skipped: [...input.skipped].sort(),
    streams: (input.fleet?.streams ?? []).map((st) => ({
      id: st.id, name: st.name, repo: st.repo,
      issues: st.issues.length, dependsOn: st.dependsOn, persona: st.persona,
    })),
    directorEnabled: input.fleet?.director?.enabled ?? false,
    deploy: {
      defined: deploymentDefined(input.deploy),
      services: (input.deploy?.services ?? []).map((sv) => ({
        id: sv.id, repo: sv.repo, platform: sv.platform, workload: sv.workload,
      })),
    },
    market: {
      defined: marketDefined(input.market),
      summary: input.market?.summary ?? "",
      recommendation: input.market?.verdict?.recommendation,
    },
  };
}
