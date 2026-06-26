// Migration SOURCE scan visualizations (#1209) — the view-models behind the Source pane's Graph /
// List / Process views: the entities (with record counts, source provenance, fields + inferred refs)
// the Graph + List views render, the ref edges for the Graph, the aggregated structured behaviors the
// Process view renders, and the multi-source provenance flag. Built from the derived Data Model and
// the scanned objects. Split out of sourceValidate.ts (#1712); the derivation lives in
// dataModelDerivation.ts and the per-source colors in sourceCatalog.ts.

import type { FieldType } from "@/features/planner/data/dataModel";
import { deriveDataModel, safeKey } from "./dataModelDerivation";
import { connectorColor } from "./sourceCatalog";
import type { PlatformScanView, SourceConfig } from "./sourceSpecs";

export interface ScanViewField { key: string; type: FieldType; required: boolean; identity: boolean; ref?: string; refLabel?: string; enumValues?: string[] }
export interface ScanViewEntity { key: string; label: string; count: number; source: string; srcColor: string; fields: ScanViewField[] }

/** The entities (with record counts, source provenance, fields + inferred refs) the Graph + List
 *  views render — built from the derived model and the scanned objects. */
export function scanEntities(cfg: SourceConfig): ScanViewEntity[] {
  const model = deriveDataModel(cfg);
  const labelByKey = new Map(model.entities.map((e) => [e.key, e.label ?? e.key]));
  const meta = new Map<string, { count: number; source: string }>();
  for (const s of cfg.sources) {
    if (s.status !== "scanned") continue;
    for (const o of s.objects ?? []) {
      const k = safeKey(o.name) || "entity";
      if (!meta.has(k)) meta.set(k, { count: o.count, source: s.connectorId }); // first wins (matches dedup)
    }
  }
  return model.entities.map((e) => {
    const m = meta.get(e.key) ?? { count: 0, source: "" };
    return {
      key: e.key,
      label: e.label ?? e.key,
      count: m.count,
      source: m.source,
      srcColor: connectorColor(m.source),
      fields: e.fields.map((f) => ({
        key: f.key, type: f.type, required: !!f.required, identity: e.identity.includes(f.key),
        ref: f.ref, refLabel: f.ref ? labelByKey.get(f.ref) ?? f.ref : undefined,
        enumValues: f.enum_values,
      })),
    };
  });
}

/** All ref relationships as edges for the Graph view. */
export function scanEdges(entities: ScanViewEntity[]): { from: string; to: string; label: string }[] {
  const keys = new Set(entities.map((e) => e.key));
  const edges: { from: string; to: string; label: string }[] = [];
  for (const e of entities) {
    for (const f of e.fields) {
      if (f.ref && keys.has(f.ref)) edges.push({ from: e.key, to: f.ref, label: `${f.key} → ${f.refLabel ?? f.ref}` });
    }
  }
  return edges;
}

/** The aggregated structured behaviors (across scanned sources) the Process view renders. */
export function aggregatePlatform(cfg: SourceConfig): PlatformScanView {
  const out: PlatformScanView = { automations: [], businessProcesses: [], derivedLogic: [] };
  for (const s of cfg.sources) {
    if (s.status !== "scanned" || !s.platform) continue;
    out.automations.push(...s.platform.automations);
    out.businessProcesses.push(...s.platform.businessProcesses);
    out.derivedLogic.push(...s.platform.derivedLogic);
  }
  return out;
}

/** Whether ≥2 distinct connector sources fed the scan (drives per-source provenance badges). */
export function isMultiSource(cfg: SourceConfig): boolean {
  return new Set(cfg.sources.filter((s) => s.status === "scanned").map((s) => s.connectorId)).size > 1;
}
