// FocusedModelBody — right-pane body for the "dataModel" stage.
//
// Read-only view of the canonical Data Model the project loads into (the TARGET the
// mapping/extraction stages aim at). Reuses the persisted `datamodel.json` (the same
// shape FocusedSourceBody writes), rendering each entity's fields with type, identity
// key, required flag, enum values / ref target — and, when the planner inferred them,
// populated-% / provenance / drop-candidate hints. Transcribed from source/sections.jsx
// (InferredModelCard).

import { useStageJson } from "./dataCollection";
import { Card } from "./DataCollectionPrimitives";
import type { DataModel, Entity, Field } from "@/features/planner/data/dataModel";

const mono = "var(--mono)";

// The persisted field shape, optionally enriched by the planner with inference hints.
type ModelField = Field & { populated?: number; provenance?: string; note?: string; drop?: boolean };

const TYPE_HUE: Record<string, number | null> = {
  string: null, bool: null, number: 230, ref: 230, money: 145, date: 195, enum: 300,
};

function TypeChip({ type }: { type: string }) {
  const h = TYPE_HUE[type] ?? null;
  const color = h == null ? "var(--fg-dim)" : `oklch(0.78 0.11 ${h})`;
  return (
    <span style={{
      fontFamily: mono, fontSize: 9, padding: "1px 6px", borderRadius: 4, color,
      background: h == null ? "var(--bg-elev)" : `color-mix(in oklch, oklch(0.74 0.12 ${h}), transparent 88%)`,
      border: "1px solid " + (h == null ? "var(--border-soft)" : `color-mix(in oklch, oklch(0.74 0.12 ${h}), transparent 72%)`),
    }}>{type}</span>
  );
}

function FieldRow({ entity, field }: { entity: Entity; field: ModelField }) {
  const isId = entity.identity.includes(field.key);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border-soft)", opacity: field.drop ? 0.6 : 1 }}>
      <span title={isId ? "identity key" : undefined} style={{ width: 12, color: isId ? "var(--accent)" : "transparent", fontSize: 10 }}>✦</span>
      <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg)", minWidth: 96 }}>{field.label || field.key}</span>
      <TypeChip type={field.type} />
      {field.required && <span style={{ fontFamily: mono, fontSize: 8.5, color: "var(--fg-dim)" }}>required</span>}
      {field.type === "ref" && field.ref && <span style={{ fontFamily: mono, fontSize: 9, color: "var(--info)" }}>→ {field.ref}</span>}
      {field.type === "enum" && (field.enum_values?.length ?? 0) > 0 && (
        <span style={{ fontFamily: mono, fontSize: 9, color: "oklch(0.78 0.11 300)" }}>{field.enum_values!.slice(0, 4).join(" · ")}{field.enum_values!.length > 4 ? " …" : ""}</span>
      )}
      <span style={{ flex: 1 }} />
      {field.populated != null && (
        <span title={field.provenance} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 36, height: 4, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", height: "100%", width: `${field.populated}%`, background: field.populated >= 70 ? "var(--success)" : "var(--accent)" }} />
          </span>
          <span style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)" }}>{field.populated}%</span>
        </span>
      )}
      {field.drop && <span style={{ fontFamily: mono, fontSize: 8.5, padding: "1px 6px", borderRadius: 4, color: "var(--accent)", border: "1px solid var(--accent-dim)" }}>drop?</span>}
    </div>
  );
}

export function FocusedModelBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<DataModel>(projectId, "datamodel");

  if (loading) {
    return <div className="empty-state" data-testid="model-loading"><span className="empty-icon">◆</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading model…</span></div>;
  }

  const entities = data?.entities ?? [];

  if (entities.length === 0) {
    return (
      <div data-testid="focused-model-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="canonical data model">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">◆</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No Data Model yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              The canonical model — the single target every source maps into — appears here once the planner writes <code>datamodel.json</code> (or the Source stage infers one from a sample).
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const fieldCount = entities.reduce((n, e) => n + e.fields.length, 0);

  return (
    <div data-testid="focused-model-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)" }}>
        ◆ <b style={{ color: "var(--fg)" }}>{data?.name || "Data Model"}</b> · {entities.length} entit{entities.length !== 1 ? "ies" : "y"} · {fieldCount} fields — the target the mapping & extraction stages aim at.
      </div>
      {entities.map((entity) => (
        <Card
          key={entity.key}
          label={entity.label || entity.key}
          hint={`identity: [${entity.identity.join(", ") || "—"}]`}
        >
          <div>
            {entity.fields.map((f) => <FieldRow key={f.key} entity={entity} field={f as ModelField} />)}
          </div>
        </Card>
      ))}
    </div>
  );
}
