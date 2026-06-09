// Blueprints tab (#513-514) — named, reusable stage-pipeline configurations.
// A Blueprint is a saved choice of which planner stages are active and what
// per-stage options apply. Users can select a Blueprint before starting a new
// planning session to pre-configure the stage pipeline.
//
// The schema lives in planStages.ts; this component is the UI surface.
import { useState } from "react";
import {
  PLAN_STAGES, BUILT_IN_BLUEPRINTS, resolveEnabledStages,
  type Blueprint, type StageId,
} from "./planStages";

/* ── helpers ─────────────────────────────────────────────────────────────── */

const STAGE_ICONS: Record<StageId, string> = {
  context:     "◎",
  repos:       "⊙",
  ui:          "▣",
  structure:   "≡",
  permissions: "⊛",
  automations: "⏱",
  skills:      "⌥",
};

function StageChip({ id, enabled, required, onToggle }: {
  id: StageId; enabled: boolean; required: boolean;
  onToggle?: (id: StageId) => void;
}) {
  const stage = PLAN_STAGES.find(s => s.id === id)!;
  const isClickable = !required && !!onToggle;
  return (
    <button
      onClick={isClickable ? () => onToggle!(id) : undefined}
      disabled={required}
      title={required ? `${stage.label} (required)` : stage.description}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "3px 8px", borderRadius: 5,
        fontFamily: "var(--mono)", fontSize: 10,
        cursor: isClickable ? "pointer" : "default",
        border: "1px solid " + (enabled
          ? "color-mix(in oklch, var(--accent), transparent 50%)"
          : "var(--border-soft)"),
        background: enabled
          ? "color-mix(in oklch, var(--accent), transparent 88%)"
          : "transparent",
        color: enabled ? "var(--accent)" : "var(--fg-dim)",
        opacity: required ? 0.75 : 1,
      }}
    >
      <span style={{ fontSize: 9 }}>{STAGE_ICONS[id]}</span>
      <span>{stage.label}</span>
      {required && <span style={{ fontSize: 8, opacity: 0.7 }}>req</span>}
    </button>
  );
}

interface BlueprintCardProps {
  blueprint: Blueprint;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}

function BlueprintCard({ blueprint, selected, onSelect, onDelete }: BlueprintCardProps) {
  const enabled = resolveEnabledStages(blueprint);
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "12px 14px", borderRadius: 8, cursor: "pointer",
        border: "1px solid " + (selected
          ? "color-mix(in oklch, var(--accent), transparent 40%)"
          : "var(--border-soft)"),
        background: selected
          ? "color-mix(in oklch, var(--accent), transparent 94%)"
          : "var(--bg-panel)",
        display: "flex", flexDirection: "column", gap: 8,
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600,
            color: selected ? "var(--accent)" : "var(--fg)",
          }}>{blueprint.name}</div>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)",
            marginTop: 3, lineHeight: 1.45,
          }}>{blueprint.description}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {selected && (
            <span style={{
              fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)",
              background: "color-mix(in oklch, var(--accent), transparent 80%)",
              border: "1px solid color-mix(in oklch, var(--accent), transparent 50%)",
              padding: "1px 7px", borderRadius: 4,
            }}>selected</span>
          )}
          {blueprint.custom && onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="Delete this Blueprint"
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                opacity: 0.7,
              }}
            >✕</button>
          )}
        </div>
      </div>

      {/* Stage chips row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {PLAN_STAGES.map(s => {
          const isEnabled = enabled.includes(s.id);
          return (
            <StageChip
              key={s.id}
              id={s.id}
              enabled={isEnabled}
              required={!s.optional}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ── Blueprint editor for user-created Blueprints ───────────────────────── */

function BlueprintEditor({ initial, onSave, onCancel }: {
  initial?: Partial<Blueprint>;
  onSave: (bp: Blueprint) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState<Set<StageId>>(
    new Set(initial?.enabledStages ?? PLAN_STAGES.map(s => s.id))
  );

  function toggle(id: StageId) {
    const stage = PLAN_STAGES.find(s => s.id === id)!;
    if (!stage.optional) return;
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleSave() {
    if (!name.trim()) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    onSave({
      id: initial?.id ?? id,
      name: name.trim(),
      description: description.trim(),
      enabledStages: PLAN_STAGES.filter(s => enabled.has(s.id)).map(s => s.id),
      custom: true,
    });
  }

  const inputStyle = {
    background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
    borderRadius: 5, padding: "6px 10px",
    fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)",
    outline: "none", width: "100%",
  };

  return (
    <div style={{
      padding: "14px 16px", borderRadius: 8,
      border: "1px solid color-mix(in oklch, var(--accent), transparent 50%)",
      background: "color-mix(in oklch, var(--accent), transparent 95%)",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
        {initial?.id ? "Edit Blueprint" : "New Blueprint"}
      </div>

      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Blueprint name…"
        style={inputStyle}
      />
      <input
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Short description…"
        style={inputStyle}
      />

      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em" }}>
          Stages
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {PLAN_STAGES.map(s => (
            <StageChip
              key={s.id}
              id={s.id}
              enabled={enabled.has(s.id)}
              required={!s.optional}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn primary"
          onClick={handleSave}
          disabled={!name.trim()}
        >Save Blueprint</button>
      </div>
    </div>
  );
}

/* ── Main Blueprints panel ───────────────────────────────────────────────── */

interface BlueprintsProps {
  /** The currently active Blueprint id (if any). */
  selectedId?: string;
  /** Called when the user selects a Blueprint. */
  onSelect?: (blueprint: Blueprint) => void;
  /** User-created Blueprints (persisted by the parent). */
  customBlueprints?: Blueprint[];
  /** Called when the user saves or edits a custom Blueprint. */
  onSaveCustom?: (blueprint: Blueprint) => void;
  /** Called when the user deletes a custom Blueprint. */
  onDeleteCustom?: (id: string) => void;
}

export function Blueprints({
  selectedId,
  onSelect,
  customBlueprints = [],
  onSaveCustom,
  onDeleteCustom,
}: BlueprintsProps) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Blueprint | null>(null);

  const allBlueprints = [...BUILT_IN_BLUEPRINTS, ...customBlueprints];

  function handleSave(bp: Blueprint) {
    onSaveCustom?.(bp);
    setCreating(false);
    setEditing(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{
        padding: "12px 20px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 10,
        background: "var(--bg-panel)",
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
            Blueprints
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", marginTop: 2 }}>
            Named stage-pipeline configurations — select one to pre-configure a new planning session
          </div>
        </div>
        <button
          className="btn ghost"
          onClick={() => { setCreating(true); setEditing(null); }}
          style={{ fontSize: 11 }}
        >+ New Blueprint</button>
      </div>

      {/* Stage legend */}
      <div style={{
        padding: "8px 20px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
        background: "var(--bg-canvas)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginRight: 4, textTransform: "uppercase", letterSpacing: ".05em" }}>stages:</span>
        {PLAN_STAGES.map(s => (
          <span key={s.id} title={s.description} style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            padding: "2px 6px", borderRadius: 4,
            fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)",
            border: "1px solid var(--border-soft)",
          }}>
            <span style={{ fontSize: 8 }}>{STAGE_ICONS[s.id]}</span>
            {s.label}
            {!s.optional && <span style={{ fontSize: 7, color: "var(--fg-dim)" }}>*</span>}
          </span>
        ))}
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginLeft: 4 }}>* required</span>
      </div>

      {/* Card list */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
        {creating && (
          <BlueprintEditor
            onSave={handleSave}
            onCancel={() => setCreating(false)}
          />
        )}
        {editing && (
          <BlueprintEditor
            initial={editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        )}

        {allBlueprints.map(bp => (
          <BlueprintCard
            key={bp.id}
            blueprint={bp}
            selected={selectedId === bp.id}
            onSelect={() => onSelect?.(bp)}
            onDelete={bp.custom ? () => onDeleteCustom?.(bp.id) : undefined}
          />
        ))}

        {allBlueprints.length === 0 && !creating && (
          <div style={{
            padding: "40px 20px", textAlign: "center",
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
          }}>
            No Blueprints yet — click &ldquo;+ New Blueprint&rdquo; to create one.
          </div>
        )}
      </div>
    </div>
  );
}
