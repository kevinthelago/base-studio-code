// Data Models library + editor (#780). Lists the canonical schemas and edits one —
// entities, fields, types, identity keys — over the pure transforms in dataModel.ts.
// The model authored here is the same wire shape the DuckDB store materializes (#781).

import { useAppStore } from "../../store";
import {
  FIELD_TYPES, checkDataModel, addEntity, removeEntity, addField, removeField, toggleIdentity,
  type DataModel, type Field,
} from "./dataModel";

const mono = "var(--mono)";

export function DataModelsPage() {
  const dataModels = useAppStore((s) => s.dataModels);
  const activeId = useAppStore((s) => s.activeDataModelId);
  const setActive = useAppStore((s) => s.setActiveDataModel);
  const addModel = useAppStore((s) => s.addDataModel);
  const setModel = useAppStore((s) => s.setDataModel);
  const removeModel = useAppStore((s) => s.removeDataModel);

  const model = dataModels.find((m) => m.id === activeId) ?? dataModels[0];
  const edit = (next: DataModel) => model && setModel(model.id, next);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Library sidebar */}
      <aside style={{
        width: 220, flex: "0 0 220px", background: "var(--bg-panel)",
        borderRight: "1px solid var(--border-soft)", padding: "14px 8px",
        display: "flex", flexDirection: "column", gap: 2, overflow: "auto",
      }}>
        <div style={{
          fontFamily: mono, fontSize: 10, letterSpacing: ".08em", color: "var(--fg-dim)",
          padding: "2px 12px 8px", textTransform: "uppercase",
        }}>Data Models</div>
        {dataModels.map((m) => {
          const on = m.id === (model?.id ?? "");
          return (
            <div key={m.id} onClick={() => setActive(m.id)} style={{
              padding: "8px 12px", borderRadius: 5, cursor: "pointer",
              background: on ? "var(--bg-elev)" : "transparent",
              borderLeft: "2px solid " + (on ? "var(--accent)" : "transparent"),
            }}>
              <div style={{ fontFamily: mono, fontSize: 12, color: on ? "var(--fg)" : "var(--fg-muted)" }}>{m.name}</div>
              <div style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>
                {m.entities.length} {m.entities.length === 1 ? "entity" : "entities"} · v{m.version}
              </div>
            </div>
          );
        })}
        <button className="btn ghost" onClick={() => addModel()} style={{ marginTop: 8, height: 32, fontSize: 12, justifyContent: "center" }}>
          + New model
        </button>
      </aside>

      {/* Editor */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "20px 24px" }}>
        {!model ? (
          <div style={{ color: "var(--fg-dim)", fontFamily: mono, fontSize: 12 }}>No Data Models — create one to start.</div>
        ) : (
          <Editor model={model} edit={edit} onDelete={() => removeModel(model.id)} />
        )}
      </div>
    </div>
  );
}

function Editor({ model, edit, onDelete }: { model: DataModel; edit: (m: DataModel) => void; onDelete: () => void }) {
  const problems = checkDataModel(model);
  const entityKeys = model.entities.map((e) => e.key);

  // Index-based property edits avoid key-lookup ambiguity mid-rename; structural ops use
  // the pure transforms.
  const setEntityProp = (ei: number, patch: Partial<{ key: string; label: string }>) =>
    edit({ ...model, entities: model.entities.map((e, i) => (i === ei ? { ...e, ...patch } : e)) });
  const setFieldProp = (ei: number, fi: number, patch: Partial<Field>) =>
    edit({
      ...model,
      entities: model.entities.map((e, i) =>
        i === ei ? { ...e, fields: e.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) } : e),
    });

  return (
    <div style={{ maxWidth: 860 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <input
          aria-label="Model name"
          value={model.name}
          onChange={(e) => edit({ ...model, name: e.target.value })}
          style={{ flex: 1, fontFamily: mono, fontSize: 18, fontWeight: 600, background: "transparent", border: "none", color: "var(--fg)", outline: "none" }}
        />
        <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)" }}>v{model.version}</span>
        <button className="btn ghost" onClick={onDelete} style={{ height: 30, fontSize: 11 }}>Delete</button>
      </div>

      {/* Validation */}
      {problems.length > 0 && (
        <div style={{
          marginBottom: 16, padding: "10px 14px", borderRadius: 8,
          background: "color-mix(in oklch, var(--warn, orange) 12%, var(--bg-panel))",
          border: "1px solid color-mix(in oklch, var(--warn, orange) 40%, transparent)",
        }}>
          <div style={{ fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-muted)", marginBottom: 6 }}>
            {problems.length} {problems.length === 1 ? "issue" : "issues"} to fix before loading
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.7 }}>
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {/* Entities */}
      {model.entities.map((e, ei) => (
        <div key={ei} style={{
          marginBottom: 16, border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--bg-panel)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border-soft)" }}>
            <span style={{ fontFamily: mono, fontSize: 12, color: "var(--accent)" }}>◆</span>
            <input
              aria-label="Entity key"
              value={e.key}
              onChange={(ev) => setEntityProp(ei, { key: ev.target.value })}
              style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, background: "transparent", border: "none", color: "var(--fg)", outline: "none", width: 160 }}
            />
            <input
              aria-label="Entity label"
              value={e.label ?? ""}
              placeholder="label"
              onChange={(ev) => setEntityProp(ei, { label: ev.target.value })}
              style={{ flex: 1, fontFamily: mono, fontSize: 11, background: "transparent", border: "none", color: "var(--fg-muted)", outline: "none" }}
            />
            <button className="btn ghost" onClick={() => edit(removeEntity(model, e.key))} style={{ height: 26, fontSize: 10 }}>Remove</button>
          </div>

          {/* Fields */}
          <div style={{ padding: "6px 12px 12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 56px 44px 1fr 28px", gap: 8, alignItems: "center",
              fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em", padding: "4px 0" }}>
              <span>field</span><span>type</span><span>req</span><span>id</span><span>validate</span><span />
            </div>
            {e.fields.map((f, fi) => (
              <div key={fi} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 56px 44px 1fr 28px", gap: 8, alignItems: "center", padding: "3px 0" }}>
                <input aria-label="Field key" value={f.key} onChange={(ev) => setFieldProp(ei, fi, { key: ev.target.value })}
                  style={inputCell} />
                <select aria-label="Field type" value={f.type} onChange={(ev) => setFieldProp(ei, fi, { type: ev.target.value as Field["type"] })}
                  style={{ ...inputCell, cursor: "pointer" }}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input type="checkbox" aria-label="Required" checked={!!f.required} onChange={(ev) => setFieldProp(ei, fi, { required: ev.target.checked })} />
                <button
                  aria-label="Toggle identity"
                  onClick={() => edit(toggleIdentity(model, e.key, f.key))}
                  title="Part of the merge identity"
                  style={{
                    height: 22, borderRadius: 5, border: "1px solid var(--border-soft)", cursor: "pointer",
                    fontFamily: mono, fontSize: 10,
                    background: e.identity.includes(f.key) ? "var(--accent)" : "transparent",
                    color: e.identity.includes(f.key) ? "var(--bg-canvas)" : "var(--fg-dim)",
                  }}
                >id</button>
                {f.type === "ref" ? (
                  <select aria-label="Ref target" value={f.ref ?? ""} onChange={(ev) => setFieldProp(ei, fi, { ref: ev.target.value })} style={{ ...inputCell, cursor: "pointer" }}>
                    <option value="">— entity —</option>
                    {entityKeys.filter((k) => k !== e.key).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                ) : (
                  <input aria-label="Validate rule" value={f.validate ?? ""} placeholder="rule" onChange={(ev) => setFieldProp(ei, fi, { validate: ev.target.value || undefined })} style={inputCell} />
                )}
                <button aria-label="Remove field" onClick={() => edit(removeField(model, e.key, f.key))}
                  style={{ background: "transparent", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 13 }}>✕</button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => edit(addField(model, e.key, { key: `field${e.fields.length + 1}`, type: "string" }))}
              style={{ marginTop: 8, height: 28, fontSize: 11 }}>+ Add field</button>
          </div>
        </div>
      ))}

      <button className="btn" onClick={() => edit(addEntity(model, `entity${model.entities.length + 1}`))}
        style={{ height: 34, fontSize: 12 }}>+ Add entity</button>
    </div>
  );
}

const inputCell: React.CSSProperties = {
  height: 26, padding: "0 8px", borderRadius: 5,
  border: "1px solid var(--border-soft)", background: "var(--bg-elev)",
  color: "var(--fg)", fontFamily: mono, fontSize: 11.5, outline: "none", minWidth: 0,
};
