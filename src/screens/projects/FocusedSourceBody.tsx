// FocusedSourceBody — right-pane body for the "source" planning stage (#se-pane).
//
// Guides the user through: pick a CSV → preview inventory → review the inferred
// Data Model with per-field provenance → inline refine (rename, retype, set
// identity, drop) → persist (sets schemaRefined). A greenfield project that has
// no source data can skip the stage.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FIELD_TYPES, checkDataModel,
  updateField, removeField, toggleIdentity,
  type DataModel, type Field, type FieldType,
} from "./dataModel";

// ── Tauri response shapes ─────────────────────────────────────────────────────

interface SourceObjectView {
  name: string;
  columns: string[];
}

// ── helper ────────────────────────────────────────────────────────────────────

function uid(): string {
  return `src-${Math.random().toString(36).slice(2, 9)}`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function FieldRow({
  entityKey,
  field,
  isIdentity,
  onRename,
  onRetype,
  onToggleId,
  onDrop,
}: {
  entityKey: string;
  field: Field;
  isIdentity: boolean;
  onRename: (key: string, label: string) => void;
  onRetype: (key: string, type: FieldType) => void;
  onToggleId: (key: string) => void;
  onDrop: (key: string) => void;
}) {
  const mono = "var(--mono)";
  return (
    <div
      data-testid={`field-row-${entityKey}-${field.key}`}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto auto",
        gap: 6,
        alignItems: "center",
        padding: "4px 0",
        borderBottom: "1px solid var(--border-soft)",
        fontSize: 12,
        fontFamily: mono,
      }}
    >
      {/* Identity toggle */}
      <button
        title={isIdentity ? "Remove from identity" : "Add to identity"}
        onClick={() => onToggleId(field.key)}
        aria-pressed={isIdentity}
        style={{
          width: 18, height: 18, borderRadius: 4, border: "1px solid var(--border-soft)",
          background: isIdentity ? "var(--accent)" : "transparent",
          color: isIdentity ? "var(--bg)" : "var(--fg-dim)",
          cursor: "pointer", fontSize: 9, lineHeight: 1,
        }}
      >
        ✦
      </button>

      {/* Display / rename */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ color: "var(--fg)", fontWeight: 500 }}>{field.key}</span>
        <input
          aria-label={`Rename ${field.key}`}
          defaultValue={field.label || field.key}
          onBlur={(e) => onRename(field.key, e.currentTarget.value)}
          style={{
            fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)",
            background: "transparent", border: "none", outline: "none",
            padding: 0,
          }}
          placeholder="label"
        />
      </div>

      {/* Provenance badge — always "CSV" for now */}
      <span style={{
        fontSize: 9, padding: "1px 5px", borderRadius: 3,
        background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
        color: "var(--fg-dim)", whiteSpace: "nowrap",
      }}>
        CSV
      </span>

      {/* Type selector */}
      <select
        aria-label={`Type for ${field.key}`}
        value={field.type}
        onChange={(e) => onRetype(field.key, e.target.value as FieldType)}
        style={{
          fontFamily: mono, fontSize: 11, background: "var(--bg-elev)",
          color: "var(--fg)", border: "1px solid var(--border-soft)",
          borderRadius: 3, padding: "1px 4px", cursor: "pointer",
        }}
      >
        {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      {/* Drop */}
      <button
        aria-label={`Drop ${field.key}`}
        onClick={() => onDrop(field.key)}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: "var(--fg-dim)", fontSize: 13,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

type Status = "idle" | "picking" | "inferring" | "ready" | "saving" | "done" | "error";

export function FocusedSourceBody({ projectId }: { projectId?: string }) {
  const mono = "var(--mono)";
  const [csvPath, setCsvPath] = useState<string | null>(null);
  const [inventory, setInventory] = useState<SourceObjectView[]>([]);
  const [model, setModel] = useState<DataModel | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  async function handlePickCsv() {
    setStatus("picking");
    setErrorMsg(null);
    try {
      const path = await invoke<string | null>("pick_csv_file");
      if (!path) { setStatus("idle"); return; }
      setCsvPath(path);
      setStatus("inferring");

      const [inv, inferred] = await Promise.all([
        invoke<SourceObjectView[]>("data_source_inventory", { csvPath: path }),
        invoke<DataModel>("data_infer_model", {
          csvPath: path,
          modelName: projectId ?? "Untitled",
        }),
      ]);
      setInventory(inv);
      // Attach a client-side id the TS DataModel type requires
      setModel({ ...inferred, id: uid() });
      setStatus("ready");
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  async function handleSave() {
    if (!model || !projectId) return;
    setStatus("saving");
    try {
      await invoke("data_persist_model", { projectKey: projectId, model, refined: true });
      setStatus("done");
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  function edit(next: DataModel) { setModel(next); }

  if (skipped) {
    return (
      <div className="empty-state" data-testid="source-skipped">
        <span className="empty-icon">⏭</span>
        <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>
          Source stage skipped — no external data for this project.
        </span>
        <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => setSkipped(false)}>
          Connect a source
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="focused-source-body"
      style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}
    >
      {/* Stage intro */}
      <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)" }}>
        Connect a data source, review the inferred schema, and refine it before loading.
      </div>

      {/* Connector picker — CSV only */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="btn"
          onClick={handlePickCsv}
          disabled={status === "picking" || status === "inferring" || status === "saving"}
          data-testid="pick-csv-btn"
          style={{ fontSize: 12, height: 30 }}
        >
          {csvPath ? "Change CSV…" : "Choose CSV file…"}
        </button>
        {csvPath && (
          <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-dim)", wordBreak: "break-all" }}>
            {csvPath.split(/[\\/]/).pop()}
          </span>
        )}
        <button
          className="btn ghost"
          onClick={() => setSkipped(true)}
          style={{ marginLeft: "auto", fontSize: 11, height: 28 }}
          data-testid="skip-source-btn"
        >
          Skip (no source data)
        </button>
      </div>

      {/* Status / error */}
      {(status === "picking" || status === "inferring") && (
        <div style={{ fontFamily: mono, fontSize: 11, color: "var(--accent)" }}>
          {status === "picking" ? "Opening file picker…" : "Inferring schema…"}
        </div>
      )}
      {status === "error" && errorMsg && (
        <div style={{ fontFamily: mono, fontSize: 11, color: "var(--danger)" }} data-testid="error-msg">
          {errorMsg}
        </div>
      )}

      {/* Inventory summary */}
      {inventory.length > 0 && (
        <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-dim)" }}>
          {inventory.map((o) => (
            <div key={o.name}>
              <strong>{o.name}</strong> — {o.columns.length} columns
            </div>
          ))}
        </div>
      )}

      {/* Model editor */}
      {model && model.entities.map((entity) => (
        <div key={entity.key} style={{ border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
          {/* Entity header */}
          <div style={{
            padding: "7px 12px",
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-soft)",
            fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--fg)",
          }}>
            {entity.label || entity.key}
            <span style={{ fontWeight: 400, color: "var(--fg-dim)", marginLeft: 6 }}>
              identity: [{entity.identity.join(", ") || "—"}]
            </span>
          </div>
          {/* Fields */}
          <div style={{ padding: "6px 12px" }}>
            {entity.fields.map((f) => (
              <FieldRow
                key={f.key}
                entityKey={entity.key}
                field={f}
                isIdentity={entity.identity.includes(f.key)}
                onRename={(key, label) => edit(updateField(model, entity.key, key, { label }))}
                onRetype={(key, type) => edit(updateField(model, entity.key, key, { type }))}
                onToggleId={(key) => edit(toggleIdentity(model, entity.key, key))}
                onDrop={(key) => edit(removeField(model, entity.key, key))}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Validation errors */}
      {model && checkDataModel(model).length > 0 && (
        <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--danger)" }}>
          {checkDataModel(model).map((p, i) => <div key={i}>{p}</div>)}
        </div>
      )}

      {/* Save / done */}
      {model && status !== "done" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            onClick={handleSave}
            disabled={status === "saving" || checkDataModel(model).length > 0}
            data-testid="confirm-model-btn"
            style={{ fontSize: 12, height: 30 }}
          >
            {status === "saving" ? "Saving…" : "Confirm & save model"}
          </button>
        </div>
      )}
      {status === "done" && (
        <div style={{ fontFamily: mono, fontSize: 11, color: "var(--success)" }} data-testid="saved-msg">
          Model saved and marked as refined ✓
        </div>
      )}
    </div>
  );
}
