// Migration SOURCE gate (#source-pane) — the pure readiness/gate helpers that drive the Source
// stage: connection counts + readiness checks, the `sourcesConnected` gate signal, and the
// datamodel.json gate signals derived from the live scan state (so the gate reflects scan progress
// without a round-trip to disk). Split out of sourceValidate.ts (#1712); the Data Model derivation
// lives in dataModelDerivation.ts and the type model in sourceSpecs.ts.

import type { ReadinessCheck } from "./readiness";
import { deriveDataModel } from "./dataModelDerivation";
import type { DeclaredSource, SourceConfig } from "./sourceSpecs";

/** A source counts as "connected" once it is scanning or fully scanned (authorized, secret on device). */
export function isConnected(s: DeclaredSource): boolean {
  return s.status === "scanning" || s.status === "scanned";
}

/** How many declared sources are connected. */
export function connectedCount(cfg: SourceConfig): number {
  return cfg.sources.filter(isConnected).length;
}

/** The `sourcesConnected` gate signal: ≥1 source declared and EVERY one fully scanned (no pending or
 *  errored source). An empty set can't pass (nothing to migrate from ⇒ the stage shouldn't apply). */
export function allSourcesConnected(cfg: SourceConfig | undefined): boolean {
  return !!cfg && cfg.sources.length > 0 && cfg.sources.every((s) => s.status === "scanned");
}

/** Readiness checks driving the in-pane banner: every declared source scanned, none errored. */
export function sourceChecks(cfg: SourceConfig): ReadinessCheck[] {
  const total = cfg.sources.length;
  const scanned = cfg.sources.filter((s) => s.status === "scanned").length;
  const errored = cfg.sources.filter((s) => s.status === "error").length;
  return [
    { id: "declared", label: "Declare the systems you're migrating from", ok: total > 0, detail: `${total} source${total !== 1 ? "s" : ""}` },
    { id: "connected", label: "Connect & scan every source", ok: total > 0 && scanned === total, detail: `${scanned}/${total} connected` },
    { id: "healthy", label: "No connection errors", ok: errored === 0, detail: errored ? `${errored} failed` : "all healthy" },
  ];
}

/** Whether a migration source is active for the project (≥1 declared source) — drives the `source`
 *  stage's `migrationSourceEnabled` so the stage applies. */
export function migrationActive(cfg: SourceConfig | undefined): boolean {
  return !!cfg && cfg.sources.length > 0;
}

/** The datamodel.json gate signals derived from the live scan state (feeds derivePlanStageState),
 *  so the source stage's gate reflects scan progress without a round-trip to disk. */
export function datamodelSignals(cfg: SourceConfig | undefined): { sourceReachable: boolean; modelInferred: boolean; schemaRefined: boolean } {
  if (!cfg) return { sourceReachable: false, modelInferred: false, schemaRefined: false };
  return {
    sourceReachable: cfg.sources.some((s) => s.status === "scanning" || s.status === "scanned"),
    modelInferred: cfg.sources.some((s) => s.status === "scanned"),
    schemaRefined: allSourcesConnected(cfg),
  };
}

/** The downstream-impact recap: what the scanned sources seed into features + structure. */
export function downstreamImpact(cfg: SourceConfig): { entities: number; fields: number; behaviors: number } {
  const m = deriveDataModel(cfg);
  const behaviors = cfg.sources.reduce((n, s) => {
    const p = s.platform;
    return n + (p ? p.automations.length + p.businessProcesses.length + p.derivedLogic.length : s.behaviors?.length ?? 0);
  }, 0);
  return { entities: m.entities.length, fields: m.entities.reduce((n, e) => n + e.fields.length, 0), behaviors };
}
