// Migration SOURCE → canonical Data Model derivation (#1205, "data dictates structure") — the pure
// helper that turns a scan into the project's Data Model: one entity per discovered object (deduped
// across sources), fields from the discovered columns (or a default `id` identity), with relationships
// resolved from connector-declared lookups (#1219) or inferred by name (#1209). This is what
// `features`/`structure` design over — persisted to datamodel.json by the Source pane. Split out of
// sourceValidate.ts (#1712); the type model lives in sourceSpecs.ts.

import type { DataModel, Entity, Field, FieldType } from "@/features/planner/data/dataModel";
import type { DiscoveredField, SourceConfig } from "./sourceSpecs";

const fieldName = (f: string | DiscoveredField): string => (typeof f === "string" ? f : f.name);
const fieldMeta = (f: string | DiscoveredField): { type?: FieldType; enumValues?: string[]; ref?: string } =>
  typeof f === "string" ? {} : { type: f.type, enumValues: f.enumValues, ref: f.ref };

/** Slug a source object/column name into a safe Data Model key (matches dataModel.ts SAFE_IDENT). */
export function safeKey(raw: string): string {
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
