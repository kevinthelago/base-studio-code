// Blueprints tab (#513): the configuration surface for the modular planning stages
// (#512). Left = the library of saved blueprints; right = the active/selected
// blueprint's stage editor (toggle on/off + reorder). The active blueprint seeds
// every new project's stage config.

import { useState } from "react";
import { useAppStore } from "../../store";
import { PLAN_STAGES, STAGE_BY_ID, type StageId } from "./planStages";

export function Blueprints() {
  const {
    blueprints, activeBlueprintId,
    setActiveBlueprint, addBlueprint, duplicateBlueprint, deleteBlueprint,
    updateBlueprintMeta, setBlueprintStageEnabled, reorderBlueprintStages,
  } = useAppStore();

  // Which blueprint is being edited (defaults to the active one).
  const [selectedId, setSelectedId] = useState(activeBlueprintId);
  const selected = blueprints.find((b) => b.id === selectedId) ?? blueprints.find((b) => b.id === activeBlueprintId) ?? blueprints[0];

  function move(order: StageId[], id: StageId, dir: -1 | 1): StageId[] {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return order;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Library */}
      <div style={{
        width: 240, flex: "0 0 240px", borderRight: "1px solid var(--border-soft)",
        display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-panel)",
      }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
          Library
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {blueprints.map((b) => {
            const isActive = b.id === activeBlueprintId;
            const isSel = b.id === selected?.id;
            return (
              <div
                key={b.id}
                onClick={() => setSelectedId(b.id)}
                style={{
                  padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                  background: isSel ? "var(--bg-elev2)" : "transparent",
                  border: "1px solid " + (isSel ? "var(--border)" : "transparent"),
                  display: "flex", alignItems: "center", gap: 6,
                  fontFamily: "var(--mono)", fontSize: 11,
                }}
              >
                <span style={{ color: isActive ? "var(--accent)" : "var(--fg-dim)", width: 10 }}>{isActive ? "●" : ""}</span>
                <span style={{ flex: 1, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                {b.builtin && <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>preset</span>}
              </div>
            );
          })}
        </div>
        <div style={{ padding: 8, borderTop: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="btn" style={{ fontFamily: "var(--mono)", fontSize: 11 }}
            onClick={() => { const id = addBlueprint("New blueprint", (selected ?? blueprints[0]).config); setSelectedId(id); }}>
            + New blueprint
          </button>
          {selected && (
            <button className="btn ghost" style={{ fontFamily: "var(--mono)", fontSize: 11 }}
              onClick={() => duplicateBlueprint(selected.id)}>
              ⧉ Duplicate
            </button>
          )}
          {selected && !selected.builtin && (
            <button className="btn ghost" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}
              onClick={() => { const next = blueprints.find((b) => b.id !== selected.id); deleteBlueprint(selected.id); if (next) setSelectedId(next.id); }}>
              🗑 Delete
            </button>
          )}
        </div>
      </div>

      {/* Active / selected blueprint editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
        {!selected ? (
          <div style={{ padding: 24, fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>No blueprint selected.</div>
        ) : (
          <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input
                value={selected.name}
                onChange={(e) => updateBlueprintMeta(selected.id, { name: e.target.value })}
                style={{
                  background: "none", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color: "var(--fg)", padding: 0,
                  minWidth: 120, maxWidth: 360,
                }}
              />
              {selected.id === activeBlueprintId
                ? <span className="tag" style={{ color: "var(--accent)" }}>● active</span>
                : <button className="btn" style={{ fontFamily: "var(--mono)", fontSize: 11 }} onClick={() => setActiveBlueprint(selected.id)}>Set active</button>}
            </div>
            <input
              value={selected.description}
              onChange={(e) => updateBlueprintMeta(selected.id, { description: e.target.value })}
              placeholder="description…"
              style={{
                background: "none", border: "none", outline: "none",
                fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg-muted)", padding: 0, maxWidth: 520,
              }}
            />

            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", marginTop: 4 }}>
              Stages — toggle on/off · reorder. The active blueprint seeds every new project.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 560 }}>
              {selected.config.order.map((id) => {
                const stage = STAGE_BY_ID[id];
                if (!stage) return null;
                const on = selected.config.enabled[id];
                return (
                  <div key={id} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px", borderRadius: 6,
                    background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
                    fontFamily: "var(--mono)", fontSize: 12,
                  }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setBlueprintStageEnabled(selected.id, id, e.target.checked)}
                      aria-label={`${stage.label} enabled`}
                    />
                    <span style={{ flex: 1, color: on ? "var(--fg)" : "var(--fg-dim)" }}>{stage.label}</span>
                    {stage.dependsOn.length > 0 && (
                      <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>needs {stage.dependsOn.join(", ")}</span>
                    )}
                    <button title="move up" className="btn ghost" style={{ padding: "0 6px", fontSize: 11 }}
                      onClick={() => reorderBlueprintStages(selected.id, move(selected.config.order, id, -1))}>↑</button>
                    <button title="move down" className="btn ghost" style={{ padding: "0 6px", fontSize: 11 }}
                      onClick={() => reorderBlueprintStages(selected.id, move(selected.config.order, id, 1))}>↓</button>
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
              {PLAN_STAGES.length} stages available · {selected.config.order.filter((id) => selected.config.enabled[id]).length} enabled
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
