// Canonical Data Model authoring (#780) — the TS side of the data-platform substrate.
//
// JSON-compatible with the Rust `bsc_data::schema` types (crates/data, #781): the same
// wire shape round-trips, so the planner / this UI author a model and the DuckDB store
// materializes it. Field names match the Rust serde output exactly (`type`, `ref`,
// `enum_values`); `id` is TS-library bookkeeping only and the Rust store ignores it
// (serde drops unknown fields).
//
// Pure (no React/Tauri) so the validation + edit transforms are unit-testable and the
// store can seed from it directly — mirrors how blueprints.ts works.
//
// SCOPE: this module owns the SHAPE (`DataModel`/`Entity`/`Field`) and the SHAPING OPS over it —
// it is NOT the canonical Data Model. The canonical model is the per-project DuckDB store in
// crates/data, reached via `bsc data model get` / `bsc data model set` (#1446); the Source pane
// derives a model from a scan (`lib/dataModelDerivation.ts`) and persists it there.
//
// The edit transforms (`addEntity` / `updateEntity` / `removeEntity` / `addField` / `updateField` /
// `removeField` / `toggleIdentity`) are the PENDING SHAPING SURFACE — the intended implementation of
// "the user shapes the derived result" — and have no UI caller yet (#3249). They are deliberately
// kept: not dead code (#3244).

export type FieldType = "string" | "number" | "bool" | "date" | "money" | "ref" | "enum";

/** Entity/field keys become SQL identifiers in the store, which whitelists exactly this
 *  shape (`ddl::quote_ident`). Surfacing it here lets the editor flag a bad key before a
 *  load would be rejected. */
export const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface Field {
  key: string;
  label?: string;
  type: FieldType;
  required?: boolean;
  /** Target entity key when `type === "ref"`. */
  ref?: string;
  /** Allowed values when `type === "enum"`. */
  enum_values?: string[];
  /** Declarative validation rule id, read by the quality gate (#783). */
  validate?: string;
}

export interface Entity {
  key: string;
  label?: string;
  fields: Field[];
  /** Field keys forming the natural / merge identity — used by the director to merge
   *  records across sources (#785). */
  identity: string[];
}

export interface DataModel {
  /** TS library id; ignored by the Rust store. */
  id: string;
  name: string;
  version: number;
  entities: Entity[];
}

/** A fresh, empty model. */
export function emptyDataModel(id: string, name = "Untitled model"): DataModel {
  return { id, name, version: 1, entities: [] };
}

/**
 * Structural validation, independent of any data — mirrors the Rust `DataModel::check`
 * plus identifier safety. Returns the list of problems (empty ⇒ valid) for the editor to
 * surface; a model with problems shouldn't be loaded.
 */
export function checkDataModel(m: DataModel): string[] {
  const problems: string[] = [];
  const seenEntities = new Set<string>();
  for (const e of m.entities) {
    if (!e.key.trim()) problems.push("an entity has an empty key");
    else if (!SAFE_IDENT.test(e.key)) problems.push(`entity key "${e.key}" is not a safe identifier`);
    if (seenEntities.has(e.key)) problems.push(`duplicate entity key "${e.key}"`);
    seenEntities.add(e.key);

    const seenFields = new Set<string>();
    for (const f of e.fields) {
      if (!f.key.trim()) problems.push(`${e.key}: a field has an empty key`);
      else if (!SAFE_IDENT.test(f.key)) problems.push(`${e.key}.${f.key}: not a safe identifier`);
      if (seenFields.has(f.key)) problems.push(`${e.key}: duplicate field key "${f.key}"`);
      seenFields.add(f.key);

      if (f.type === "ref") {
        if (!f.ref) problems.push(`${e.key}.${f.key}: ref field has no target entity`);
        else if (!m.entities.some((x) => x.key === f.ref)) problems.push(`${e.key}.${f.key}: ref to unknown entity "${f.ref}"`);
      }
    }
    for (const id of e.identity) {
      if (!e.fields.some((f) => f.key === id)) problems.push(`${e.key}: identity field "${id}" is not a field`);
    }
  }
  return problems;
}

// ── pure edit transforms (return a new model) ─────────────────────────────────

const mapEntity = (m: DataModel, key: string, fn: (e: Entity) => Entity): DataModel => ({
  ...m,
  entities: m.entities.map((e) => (e.key === key ? fn(e) : e)),
});

export function addEntity(m: DataModel, key: string): DataModel {
  return { ...m, entities: [...m.entities, { key, label: "", fields: [], identity: [] }] };
}

export function updateEntity(m: DataModel, key: string, patch: Partial<Pick<Entity, "key" | "label">>): DataModel {
  return mapEntity(m, key, (e) => ({ ...e, ...patch }));
}

export function removeEntity(m: DataModel, key: string): DataModel {
  return { ...m, entities: m.entities.filter((e) => e.key !== key) };
}

export function addField(m: DataModel, entityKey: string, field: Field): DataModel {
  return mapEntity(m, entityKey, (e) => ({ ...e, fields: [...e.fields, field] }));
}

export function updateField(m: DataModel, entityKey: string, fieldKey: string, patch: Partial<Field>): DataModel {
  return mapEntity(m, entityKey, (e) => ({
    ...e,
    fields: e.fields.map((f) => (f.key === fieldKey ? { ...f, ...patch } : f)),
  }));
}

export function removeField(m: DataModel, entityKey: string, fieldKey: string): DataModel {
  return mapEntity(m, entityKey, (e) => ({
    ...e,
    fields: e.fields.filter((f) => f.key !== fieldKey),
    identity: e.identity.filter((id) => id !== fieldKey),
  }));
}

/** Toggle whether a field is part of the entity's merge identity. */
export function toggleIdentity(m: DataModel, entityKey: string, fieldKey: string): DataModel {
  return mapEntity(m, entityKey, (e) => ({
    ...e,
    identity: e.identity.includes(fieldKey) ? e.identity.filter((id) => id !== fieldKey) : [...e.identity, fieldKey],
  }));
}

/** Starter library — one canonical CRM model so the page isn't empty and the wire format
 *  is demonstrated end-to-end. */
export function seedDataModels(): DataModel[] {
  return [
    {
      id: "dm-crm",
      name: "CRM Core",
      version: 1,
      entities: [
        {
          key: "account", label: "Account", identity: ["id"],
          fields: [
            { key: "id", type: "string", required: true },
            { key: "name", type: "string", required: true },
            { key: "industry", type: "string" },
            { key: "annual_revenue", type: "money" },
          ],
        },
        {
          key: "contact", label: "Contact", identity: ["id"],
          fields: [
            { key: "id", type: "string", required: true },
            { key: "full_name", type: "string", required: true },
            { key: "email", type: "string" },
            { key: "account", type: "ref", ref: "account" },
          ],
        },
      ],
    },
  ];
}
