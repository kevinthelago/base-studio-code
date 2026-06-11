// BlueprintLibrary — issue #662 #670 #664.
// Shows the built-in Shape archetypes as selectable cards.
// - Card click → opens inline editor (#670)
// - "Use" button on each card → selects blueprint directly (#662)
// - ✓ in-use badge on the currently applied blueprint (#662)
// - "Use" is the primary CTA in the editor; "Publish to gist" is secondary (#670)
// - Reset modal when switching from an existing blueprint or pre-tracking project (#664)
import { useState } from "react";
import { BUILTIN_ARCHETYPES } from "../shape";
import type { Shape, ShapeLayer } from "../shape";
import { layerTitle } from "../shaping";

/* =================================================================
   types
   ================================================================= */

export interface BlueprintLibraryProps {
  /** The blueprint currently in use for this project (null = none). */
  activeBlueprintId: string | null;
  /** Called when the user confirms a blueprint selection. */
  onUse: (blueprintId: string) => void;
  /** Called when the user dismisses the library panel. */
  onClose?: () => void;
}

/* =================================================================
   helpers
   ================================================================= */

const ARCHETYPES = Object.values(BUILTIN_ARCHETYPES);

function tierColor(tier: "default" | "policy"): string {
  return tier === "policy" ? "var(--danger)" : "var(--fg-dim)";
}

/* =================================================================
   BlueprintResetModal (#664)
   ================================================================= */

interface BlueprintResetModalProps {
  blueprintName: string;
  onCancel: () => void;
  onExport: () => void;
  onConfirm: () => void;
}

export function BlueprintResetModal({
  blueprintName,
  onCancel,
  onExport,
  onConfirm,
}: BlueprintResetModalProps) {
  return (
    <div
      data-testid="blueprint-reset-modal"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{
        width: "min(460px, 92vw)",
        background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
        borderRadius: 10, padding: "24px 28px",
        boxShadow: "0 16px 50px rgba(0,0,0,.45)",
      }}>
        <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>
          Switch to <em style={{ fontStyle: "normal", color: "var(--accent)" }}>{blueprintName}</em>?
        </h3>
        <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
          Applying a new blueprint <strong style={{ color: "var(--fg)" }}>resets to a fresh state</strong> — all
          current planning sections, confirmed items, and fleet configuration will be cleared.
        </p>
        <p style={{ margin: "0 0 20px", fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.55 }}>
          Export your files first if you want to keep a copy.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            data-testid="reset-modal-cancel"
            className="btn ghost"
            onClick={onCancel}
            style={{ fontFamily: "var(--mono)", fontSize: 11 }}
          >cancel</button>
          <button
            data-testid="reset-modal-export"
            className="btn"
            onClick={onExport}
            style={{ fontFamily: "var(--mono)", fontSize: 11 }}
          >export files</button>
          <button
            data-testid="reset-modal-confirm"
            className="btn danger"
            onClick={onConfirm}
            style={{ fontFamily: "var(--mono)", fontSize: 11 }}
          >confirm & restart</button>
        </div>
      </div>
    </div>
  );
}

/* =================================================================
   BlueprintEditor (#670) — inline detail panel for a selected card
   ================================================================= */

interface BlueprintEditorProps {
  shape: Shape;
  isActive: boolean;
  onUse: () => void;
  onClose: () => void;
}

function BlueprintEditor({ shape, isActive, onUse, onClose }: BlueprintEditorProps) {
  return (
    <div
      data-testid="blueprint-editor"
      style={{
        background: "var(--bg-canvas)",
        border: "1px solid var(--accent-dim)",
        borderRadius: 8,
        overflow: "hidden",
        marginTop: 10,
      }}
    >
      {/* Editor header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-panel)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--fg)", flex: 1 }}>
          {shape.name}
        </span>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 8.5, padding: "1px 6px", borderRadius: 3,
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-dim)",
        }}>
          {shape.source}
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12,
            padding: "0 4px",
          }}
        >✕</button>
      </div>

      {/* Layers list */}
      <div style={{ padding: "12px 14px" }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8,
        }}>
          layers ({shape.layers.length})
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {shape.layers.map((layer: ShapeLayer) => (
            <div key={layer.id} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "5px 8px", borderRadius: 5,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: 2, flex: "0 0 6px",
                background: tierColor(layer.tier),
              }} />
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>
                {layer.title || layerTitle(layer.id as Parameters<typeof layerTitle>[0])}
              </span>
              {layer.tier === "policy" && (
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 8, padding: "1px 5px", borderRadius: 3,
                  background: "color-mix(in oklch, var(--danger), transparent 85%)",
                  border: "1px solid color-mix(in oklch, var(--danger), transparent 65%)",
                  color: "var(--danger)",
                }}>
                  policy
                </span>
              )}
            </div>
          ))}
          {shape.layers.length === 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", padding: "8px 0" }}>
              No layers defined.
            </div>
          )}
        </div>
        {shape.dimensions && shape.dimensions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6,
            }}>
              dimensions
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {shape.dimensions.map(d => (
                <span key={d} style={{
                  fontFamily: "var(--mono)", fontSize: 9, padding: "2px 7px", borderRadius: 3,
                  background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                  color: "var(--fg-muted)",
                }}>{d}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Editor CTAs — Use is primary, Publish to gist is secondary (#670) */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", borderTop: "1px solid var(--border-soft)",
        background: "var(--bg-panel)",
      }}>
        <button
          data-testid={`blueprint-editor-use-${shape.id}`}
          className="btn primary"
          onClick={onUse}
          disabled={isActive}
          style={{ fontFamily: "var(--mono)", fontSize: 11, flex: 1 }}
        >
          {isActive ? "✓ in use" : `Use ${shape.name}`}
        </button>
        <button
          data-testid={`blueprint-editor-gist-${shape.id}`}
          className="btn ghost"
          style={{ fontFamily: "var(--mono)", fontSize: 10, whiteSpace: "nowrap" }}
          onClick={() => { /* publish-to-gist: demoted to secondary, no-op for now */ }}
        >
          publish to gist ↗
        </button>
      </div>
    </div>
  );
}

/* =================================================================
   BlueprintCard (#662)
   ================================================================= */

interface BlueprintCardProps {
  shape: Shape;
  isActive: boolean;
  isEditing: boolean;
  onClick: () => void;
  onUse: () => void;
}

function BlueprintCard({ shape, isActive, isEditing, onClick, onUse }: BlueprintCardProps) {
  return (
    <div
      data-testid={`blueprint-card-${shape.id}`}
      onClick={onClick}
      style={{
        borderRadius: 7, overflow: "hidden",
        background: isEditing ? "var(--bg-canvas)" : "var(--bg-elev)",
        border: "1px solid " + (isActive ? "var(--accent-dim)" : isEditing ? "var(--accent-dim)" : "var(--border-soft)"),
        cursor: "pointer",
        transition: "border-color .12s",
      }}
    >
      <div style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 2, flex: "0 0 8px",
            background: isActive ? "var(--accent)" : "var(--fg-dim)",
          }} />
          <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5, fontWeight: 600, color: "var(--fg)" }}>
            {shape.name}
          </span>
          {isActive && (
            <span
              data-testid={`blueprint-badge-inuse-${shape.id}`}
              style={{
                fontFamily: "var(--mono)", fontSize: 8.5, padding: "1px 6px", borderRadius: 4,
                background: "color-mix(in oklch, var(--accent), transparent 84%)",
                border: "1px solid var(--accent-dim)", color: "var(--accent)",
              }}
            >
              ✓ in use
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 7, flexWrap: "wrap" }}>
          {shape.layers.slice(0, 5).map(l => (
            <span key={l.id} style={{
              fontFamily: "var(--mono)", fontSize: 8.5, padding: "1px 5px", borderRadius: 3,
              background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
              color: tierColor(l.tier),
            }}>
              {l.title || l.id}
            </span>
          ))}
          {shape.layers.length > 5 && (
            <span style={{
              fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)", padding: "1px 3px",
            }}>+{shape.layers.length - 5}</span>
          )}
        </div>
      </div>
      <div style={{
        borderTop: "1px solid var(--border-soft)", padding: "7px 10px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "var(--bg-panel)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
          {shape.layers.length} layer{shape.layers.length !== 1 ? "s" : ""}
          {shape.source !== "builtin" && (
            <> · <span style={{ color: "var(--accent)" }}>{shape.source}</span></>
          )}
        </span>
        <button
          data-testid={`blueprint-use-${shape.id}`}
          className={isActive ? "btn ghost" : "btn primary"}
          onClick={e => { e.stopPropagation(); onUse(); }}
          disabled={isActive}
          style={{ fontFamily: "var(--mono)", fontSize: 9.5, height: 22, padding: "0 10px" }}
        >
          {isActive ? "✓ in use" : "Use"}
        </button>
      </div>
    </div>
  );
}

/* =================================================================
   BlueprintLibrary — main export (#662 #670 #664)
   ================================================================= */

export function BlueprintLibrary({
  activeBlueprintId,
  onUse,
  onClose,
}: BlueprintLibraryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);  // awaiting reset confirm

  const editingShape = editingId ? (BUILTIN_ARCHETYPES[editingId] ?? null) : null;
  const pendingShape = pendingId ? (BUILTIN_ARCHETYPES[pendingId] ?? null) : null;

  // #664: "pre-tracking" project — activeBlueprintId = "default" is the sentinel that
  // means "project has existing sections; treat as if a blueprint was already in use."
  const hasExistingBlueprint = activeBlueprintId !== null;

  function handleUse(blueprintId: string) {
    if (blueprintId === activeBlueprintId) return;
    if (hasExistingBlueprint) {
      // Show reset modal (#664) — switching blueprints clears existing state
      setPendingId(blueprintId);
    } else {
      onUse(blueprintId);
    }
  }

  function handleConfirmReset() {
    if (pendingId) {
      onUse(pendingId);
      setPendingId(null);
      setEditingId(null);
    }
  }

  return (
    <>
      <div
        data-testid="blueprint-library"
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg-panel)",
        }}
      >
        {/* Library header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
        }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color: "var(--fg)" }}>
            Blueprint Library
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
            {ARCHETYPES.length} built-in archetypes
          </span>
          <span style={{ flex: 1 }} />
          {onClose && (
            <button
              data-testid="blueprint-library-close"
              onClick={onClose}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 11,
                padding: "0 4px",
              }}
            >✕</button>
          )}
        </div>

        {/* Card grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 8,
        }}>
          {ARCHETYPES.map(shape => (
            <div key={shape.id}>
              <BlueprintCard
                shape={shape}
                isActive={activeBlueprintId === shape.id}
                isEditing={editingId === shape.id}
                onClick={() => setEditingId(editingId === shape.id ? null : shape.id)}
                onUse={() => handleUse(shape.id)}
              />
              {editingId === shape.id && editingShape && (
                <BlueprintEditor
                  shape={editingShape}
                  isActive={activeBlueprintId === editingShape.id}
                  onUse={() => handleUse(editingShape.id)}
                  onClose={() => setEditingId(null)}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Reset modal (#664) */}
      {pendingId && pendingShape && (
        <BlueprintResetModal
          blueprintName={pendingShape.name}
          onCancel={() => setPendingId(null)}
          onExport={() => {
            // Export files: no-op stub — the real export would write plan files.
            // For now, dismiss the modal (export didn't restart).
            setPendingId(null);
          }}
          onConfirm={handleConfirmReset}
        />
      )}
    </>
  );
}
