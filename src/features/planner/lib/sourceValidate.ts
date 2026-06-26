// Migration SOURCE validation + derivation (#source-pane) — the pure helpers that drive the Source
// stage gate and the scan view-models: connection counts + readiness checks, the canonical Data Model
// derivation (#1205, "data dictates structure"), the gate signals, the scan visualizations (Graph /
// List / Process view-models, #1209), and the lenient planner-channel coercion of a `<source_config>`
// payload. Split out of sourceConfig.ts (#1638); the type model lives in sourceSpecs.ts and the
// connector catalog in sourceCatalog.ts.

import type { DataModel, Entity, Field, FieldType } from "@/features/planner/data/dataModel";
import type { ReadinessCheck } from "./readiness";
import { CONNECTORS, connector, connectorColor } from "./sourceCatalog";
import type {
  DeclaredSource, DiscoveredField, PlatformScanView, SourceConfig, SourceStatus,
} from "./sourceSpecs";

const fieldName = (f: string | DiscoveredField): string => (typeof f === "string" ? f : f.name);
const fieldMeta = (f: string | DiscoveredField): { type?: FieldType; enumValues?: string[]; ref?: string } =>
  typeof f === "string" ? {} : { type: f.type, enumValues: f.enumValues, ref: f.ref };

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

// ── Derive the canonical Data Model from a scan (#1205 — "data dictates structure") ─────────────
// The scanned sources seed the project's canonical Data Model: one entity per discovered object
// (deduped across sources), fields from the discovered columns when present (else a default `id`
// identity to start from). This is what `features`/`structure` design over — persisted to
// datamodel.json by the Source pane and surfaced as the downstream-impact recap.

/** Slug a source object/column name into a safe Data Model key (matches dataModel.ts SAFE_IDENT). */
function safeKey(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(s) ? s : `e_${s}`;
}

/** Build a Data Model from the scanned sources — entities from discovered objects, fields from
 *  their columns (or a default `id` key), deduped by entity key. */
export function deriveDataModel(cfg: SourceConfig, id = "dm-source"): DataModel {
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const s of cfg.sources) {
    if (s.status !== "scanned") continue;
    for (const o of s.objects ?? []) {
      const key = safeKey(o.name) || "entity";
      if (seen.has(key)) continue; // one entity per object name, across sources
      seen.add(key);
      const fseen = new Set<string>();
      const cols = (o.fields ?? [])
        .map((f) => ({ key: safeKey(fieldName(f)), meta: fieldMeta(f) }))
        .filter((c) => c.key && !fseen.has(c.key) && (fseen.add(c.key), true));
      const fields: Field[] = cols.length
        ? cols.map((c) => ({
            key: c.key,
            type: c.meta.type ?? "string",
            ...(c.meta.enumValues && c.meta.enumValues.length ? { enum_values: c.meta.enumValues } : {}),
            ...(c.meta.ref ? { ref: safeKey(c.meta.ref) } : {}),
          }))
        : [{ key: "id", type: "string" as const, required: true }];
      const identity = fields.some((f) => f.key === "id") ? ["id"] : fields[0] ? [fields[0].key] : [];
      entities.push({ key, label: o.name, fields, identity });
    }
  }
  // Resolve relationships. A connector-declared lookup (#1219, e.g. Salesforce AccountId → Account)
  // wins when its target was scanned — it's exact, and its field key (`accountid`) wouldn't match by
  // name. Otherwise infer (#1209): a field whose key matches another entity's key is a `ref` to it
  // (e.g. Contact.account → Account). Either gives the graph its edges and the list its ref chips.
  const entityKeys = new Set(entities.map((e) => e.key));
  for (const e of entities) {
    for (const f of e.fields) {
      if (f.ref && entityKeys.has(f.ref)) {
        f.type = "ref";
        delete f.enum_values; // a ref isn't an enum
      } else if (f.key !== e.key && entityKeys.has(f.key)) {
        f.type = "ref";
        f.ref = f.key;
        delete f.enum_values;
      } else if (f.ref) {
        // Declared ref to an object that wasn't scanned — drop the dangling link, keep a plain field.
        delete f.ref;
        if (f.type === "ref") f.type = "string";
      }
    }
  }
  return { id, name: cfg.dataModelName || "Source Data Model", version: 1, entities };
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

// ── Scan visualizations (#1209) — the view-model behind the Graph / List / Process views ─────────

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

// ── Planner channel (forward-compat): coerce a lenient `<source_config>` payload → a SourceConfig.
//    The planner can PROPOSE sources from the pitch and pre-fill non-secret connection hints; it can
//    never supply a secret (those are entered on-device), so any secret-looking field is dropped. ──
type Raw = Record<string, unknown>;
const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const asArr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object") : []);
const STATUSES: SourceStatus[] = ["declared", "connecting", "scanning", "scanned", "error"];

export function coerceSourceConfig(raw: unknown): SourceConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const proposed = (Array.isArray(o.proposed) ? o.proposed : [])
    .map((x) => asStr(x))
    .filter((id) => CONNECTORS.some((c) => c.id === id));
  const sources: DeclaredSource[] = asArr(o.sources).map((s, i) => {
    const connectorId = CONNECTORS.some((c) => c.id === asStr(s.connectorId)) ? asStr(s.connectorId) : "quickbase";
    const spec = connector(connectorId).spec;
    const secretKeys = new Set(spec.fields.filter((f) => f.secret).map((f) => f.key));
    const rawFields = (s.fields && typeof s.fields === "object" ? s.fields : {}) as Raw;
    const fields: Record<string, string> = {};
    // Keep only NON-SECRET field hints — a secret can never be carried in over the channel.
    for (const [k, v] of Object.entries(rawFields)) {
      if (!secretKeys.has(k) && typeof v === "string") fields[k] = v;
    }
    const status = STATUSES.includes(asStr(s.status) as SourceStatus) ? (asStr(s.status) as SourceStatus) : "declared";
    return {
      uid: asStr(s.uid) || `src-${connectorId}-${i}`,
      connectorId,
      instance: asStr(s.instance) || undefined,
      env: s.env === "sandbox" ? "sandbox" : s.env === "production" ? "production" : undefined,
      // A coerced source is never trusted as already-connected — credentials are entered on-device,
      // so anything past `declared` resets to `declared` (the user must connect it here).
      status: status === "error" ? "error" : "declared",
      fields,
    };
  });
  return { dataModelName: asStr(o.dataModelName) || asStr((o.dataModel as Raw)?.name), proposed, sources };
}

/** Parse a `<source_config>` tag body into a SourceConfig (forgiving: extracts the outermost JSON
 *  object, tolerates wrapping prose). Returns null if no JSON object is present. */
export function parseSourceConfigTag(body: string): SourceConfig | null {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return coerceSourceConfig(JSON.parse(json));
  } catch {
    try {
      return coerceSourceConfig(JSON.parse(json.replace(/[ \t]*[\r\n]+[ \t]*/g, " ")));
    } catch {
      return null;
    }
  }
}
