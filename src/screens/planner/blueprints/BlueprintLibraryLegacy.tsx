// Blueprint library UX (#662, #670, #664) — card grid + inline editor + reset modal.
import { useState } from "react";
import { BUILTIN_ARCHETYPES } from "../data/shape";
import type { Shape } from "../data/shape";

export interface BlueprintResetModalProps {
  blueprintName: string;
  onCancel: () => void;
  onExport: () => void;
  onConfirm: () => void;
}

export function BlueprintResetModal({ blueprintName, onCancel, onExport, onConfirm }: BlueprintResetModalProps) {
  return (
    <div
      data-testid="blueprint-reset-modal"
      style={{
        position: "fixed", inset: 0, zIndex: 60, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "color-mix(in oklch, var(--bg-canvas), transparent 30%)",
      }}
    >
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: 10, padding: "20px 22px", width: "min(420px, 90vw)",
        boxShadow: "0 12px 40px rgba(0,0,0,.4)",
      }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          Switch to <b>{blueprintName}</b>?
        </div>
        <p style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--fg-muted)", margin: "0 0 16px" }}>
          This resets to a fresh state — all current plan sections and sections will be cleared.
          Export your files first to save your work.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button data-testid="reset-modal-cancel" onClick={onCancel} style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
            Cancel
          </button>
          <button data-testid="reset-modal-export" onClick={onExport} style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
            Export files
          </button>
          <button
            data-testid="reset-modal-confirm"
            onClick={onConfirm}
            style={{
              fontFamily: "var(--mono)", fontSize: 10.5,
              background: "var(--danger)", color: "#fff",
              border: "none", borderRadius: 5, padding: "4px 12px", cursor: "pointer",
            }}
          >
            Confirm &amp; restart
          </button>
        </div>
      </div>
    </div>
  );
}

function BlueprintEditor({ archetype, onUse }: { archetype: Shape; onUse: () => void }) {
  return (
    <div
      data-testid="blueprint-editor"
      style={{
        marginTop: 8, padding: "12px 14px", borderRadius: 7,
        background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
        {archetype.name}
      </div>
      {archetype.dimensions && archetype.dimensions.length > 0 && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 10 }}>
          dimensions: {archetype.dimensions.join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          data-testid={`blueprint-editor-use-${archetype.id}`}
          onClick={onUse}
          style={{
            fontFamily: "var(--mono)", fontSize: 10.5, padding: "3px 12px",
            background: "color-mix(in oklch, var(--accent), transparent 80%)",
            color: "var(--accent)", border: "1px solid var(--accent-dim)",
            borderRadius: 5, cursor: "pointer",
          }}
        >
          Use this blueprint
        </button>
        <button
          data-testid={`blueprint-editor-gist-${archetype.id}`}
          style={{
            fontFamily: "var(--mono)", fontSize: 9.5, padding: "3px 10px",
            background: "transparent", color: "var(--fg-dim)",
            border: "1px solid var(--border-soft)", borderRadius: 5, cursor: "pointer",
          }}
        >
          publish to gist
        </button>
      </div>
    </div>
  );
}

interface BlueprintCardProps {
  archetype: Shape;
  isActive: boolean;
  onUse: () => void;
  onToggleEdit: () => void;
}

function BlueprintCard({ archetype, isActive, onUse, onToggleEdit }: BlueprintCardProps) {
  return (
    <div
      data-testid={`blueprint-card-${archetype.id}`}
      onClick={onToggleEdit}
      style={{
        padding: "10px 12px", borderRadius: 7, cursor: "pointer",
        background: "var(--bg-canvas)",
        border: "1px solid " + (isActive ? "var(--accent-dim)" : "var(--border-soft)"),
        display: "flex", alignItems: "center", gap: 10,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>
            {archetype.name}
          </span>
          {isActive && (
            <span
              data-testid={`blueprint-badge-inuse-${archetype.id}`}
              style={{
                fontFamily: "var(--mono)", fontSize: 9, padding: "1px 6px", borderRadius: 3,
                background: "color-mix(in oklch, var(--success), transparent 80%)",
                color: "var(--success)", border: "1px solid color-mix(in oklch,var(--success),transparent 60%)",
              }}
            >
              ✓ in use
            </span>
          )}
        </div>
        {archetype.dimensions && archetype.dimensions.length > 0 && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginTop: 3 }}>
            {archetype.dimensions.join(" · ")}
          </div>
        )}
      </div>
      <button
        data-testid={`blueprint-use-${archetype.id}`}
        disabled={isActive}
        onClick={(e) => { e.stopPropagation(); onUse(); }}
        style={{
          fontFamily: "var(--mono)", fontSize: 10, padding: "3px 10px",
          background: isActive ? "transparent" : "color-mix(in oklch, var(--accent), transparent 82%)",
          color: isActive ? "var(--fg-dim)" : "var(--accent)",
          border: "1px solid " + (isActive ? "var(--border-soft)" : "var(--accent-dim)"),
          borderRadius: 5, cursor: isActive ? "default" : "pointer", opacity: isActive ? 0.5 : 1,
        }}
      >
        Use
      </button>
    </div>
  );
}

export interface BlueprintLibraryProps {
  activeBlueprintId: string | null;
  onUse: (id: string) => void;
  onClose?: () => void;
}

export function BlueprintLibrary({ activeBlueprintId, onUse, onClose }: BlueprintLibraryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);

  const archetypes = Object.values(BUILTIN_ARCHETYPES);

  const handleUse = (id: string) => {
    if (id === activeBlueprintId) return;
    if (activeBlueprintId === null) {
      onUse(id);
    } else {
      setResetTarget(id);
    }
  };

  const resetTargetArchetype = resetTarget
    ? archetypes.find((a) => a.id === resetTarget)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {onClose && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 8px 0" }}>
          <button
            data-testid="blueprint-library-close"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}
          >
            ✕
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0" }}>
        {archetypes.map((a) => (
          <div key={a.id}>
            <BlueprintCard
              archetype={a}
              isActive={activeBlueprintId === a.id}
              onUse={() => handleUse(a.id)}
              onToggleEdit={() => setEditingId((prev) => (prev === a.id ? null : a.id))}
            />
            {editingId === a.id && (
              <BlueprintEditor archetype={a} onUse={() => handleUse(a.id)} />
            )}
          </div>
        ))}
      </div>

      {resetTarget !== null && (
        <BlueprintResetModal
          blueprintName={resetTargetArchetype?.name ?? resetTarget}
          onCancel={() => setResetTarget(null)}
          onExport={() => setResetTarget(null)}
          onConfirm={() => {
            onUse(resetTarget);
            setResetTarget(null);
          }}
        />
      )}
    </div>
  );
}
