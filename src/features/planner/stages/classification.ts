// Discovery classification signals + the pure stage-selection engine (#1395 phase 2).
//
// The Discovery phase characterizes a project into a small set of SIGNALS; `proposeStages` maps
// those signals to the set of catalog stages that apply. This is the standalone selection engine
// that, in the dynamic-stages model, replaces a blueprint's hand-picked stage set.
//
// Deliberately SELF-CONTAINED: the per-stage applicability rules live HERE (keyed by StageId), NOT
// as new `signals`/`phase` fields on the catalog `Stage` objects — that catalog schema change is
// held until #1462 (prompt-data unification) lands, to avoid churning the shared stage definitions.
// Pure (no React / store / Tauri) so it's trivially unit-testable.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";

export type Lifecycle = "greenfield" | "transform" | "harden" | "maintain";
export type Surface = "ui" | "cli" | "api" | "service" | "library" | "data";
export type ServiceTopology = "none" | "split" | "combine";
export type DeployKind = "none" | "static" | "serverless" | "container" | "service";

/** Discovery's output — the only inputs to stage selection (#1395). Planner-set as it learns, plus
 *  a few counts derived from plan state. */
export interface ClassificationSignals {
  lifecycle: Lifecycle;
  /** ⊆ {ui, cli, api, service, library, data} — what the project exposes. */
  surfaces: Surface[];
  provenance: "new" | "existing";
  migration: boolean;
  dataModel: boolean;
  serviceTopology: ServiceTopology;
  deploy: DeployKind;
  compliance: boolean;
  // derived from plan state:
  featureCount: number;
  repoCount: number;
  streamCount: number;
}

/** A neutral signal set (greenfield, no surfaces) — the baseline a test or caller overrides. */
export function defaultSignals(over: Partial<ClassificationSignals> = {}): ClassificationSignals {
  return {
    lifecycle: "greenfield",
    surfaces: [],
    provenance: "new",
    migration: false,
    dataModel: false,
    serviceTopology: "none",
    deploy: "none",
    compliance: false,
    featureCount: 0,
    repoCount: 0,
    streamCount: 0,
    ...over,
  };
}

const SOFTWARE_SURFACES: Surface[] = ["ui", "cli", "api", "service", "library"];
/** The project produces software (vs a pure data-only project). */
export const buildsCode = (s: ClassificationSignals): boolean => s.surfaces.some((x) => SOFTWARE_SURFACES.includes(x));

/**
 * Whether a catalog stage applies, given the classification signals — the epic's "Applies when"
 * table. `automations`/`skills` are opt-in (not signal-driven), so they never auto-enable here;
 * the planner adds them explicitly via `stage require`. Unknown ids (e.g. the signal-only `load`)
 * are off.
 */
export function stageApplies(id: StageId, s: ClassificationSignals): boolean {
  switch (id) {
    case "discovery":     return true;                                          // Discovery — always on
    case "repos":       return buildsCode(s);                                 // software surfaces
    case "source":      return s.migration || s.dataModel;                    // a migration source / data model
    case "features":    return s.lifecycle === "greenfield";
    case "ui":          return s.surfaces.includes("ui");
    case "structure":   return s.lifecycle === "greenfield" && (s.featureCount >= 2 || s.repoCount > 1);
    case "permissions": return buildsCode(s) && s.lifecycle !== "maintain";   // builds code → needs a fleet
    case "automations": return false;                                         // opt-in
    case "skills":      return false;                                         // opt-in
    default:            return false;
  }
}

/**
 * Propose a project's {@link StageConfig} purely from its classification signals (#1395 phase 2):
 * which catalog stages light up, in the registry's order. The order TIER (`phase`) and folding the
 * rules onto the catalog are held (#1462 overlap) — this is just the selection engine.
 */
export function proposeStages(signals: ClassificationSignals): StageConfig {
  return {
    enabled: Object.fromEntries(PLAN_STAGES.map((st) => [st.id, stageApplies(st.id, signals)])) as Record<StageId, boolean>,
    order: PLAN_STAGES.map((st) => st.id),
  };
}
