import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Pencil } from "lucide-react";

export interface Tab {
  name: string;
  layout: string;
  state?: "run" | "on" | "idle";
  // Bumped when a tab's sessions are relaunched (e.g. triage re-run) so the panes
  // remount with fresh PTYs. Woven into ConsoleScreen's pane key; transient.
  runId?: number;
}

const LAYOUTS = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"] as const;

interface ContextMenuState {
  tabIdx: number;
  x: number;
  y: number;
}

interface TabstripProps {
  tabs: Tab[];
  activeIdx?: number;
  onSelect?: (idx: number) => void;
  onClose?: (idx: number) => void;
  onAdd?: () => void;
  onRename?: (idx: number, name: string) => void;
  onChangeLayout?: (idx: number, layout: string) => void;
  /** Reorder a tab from index `from` to `to` (drag-and-drop within the strip). */
  onReorder?: (from: number, to: number) => void;
}

export function Tabstrip({
  tabs,
  activeIdx = 0,
  onSelect,
  onClose,
  onAdd,
  onRename,
  onChangeLayout,
  onReorder,
}: TabstripProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Drag-to-reorder: index being dragged, and the index it's hovering over.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingIdx !== null) editInputRef.current?.select();
  }, [editingIdx]);

  useEffect(() => {
    if (!contextMenu) return;
    function onMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setContextMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const commitRename = useCallback(() => {
    if (editingIdx === null) return;
    const trimmed = editingName.trim();
    if (trimmed) onRename?.(editingIdx, trimmed);
    setEditingIdx(null);
  }, [editingIdx, editingName, onRename]);

  function startRename(idx: number) {
    setContextMenu(null);
    setEditingIdx(idx);
    setEditingName(tabs[idx].name);
  }

  function handleContextMenu(e: React.MouseEvent, idx: number) {
    e.preventDefault();
    // Clamp the menu so it doesn't overflow the right edge
    const menuWidth = 220;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    setContextMenu({ tabIdx: idx, x, y: e.clientY });
  }

  return (
    <>
      <div className="tabstrip">
        {tabs.map((t, i) => (
          <div
            key={i}
            className={"tab " + (i === activeIdx ? "active" : "")}
            // Disable drag while renaming so the input stays text-selectable.
            draggable={editingIdx !== i}
            onClick={() => { if (editingIdx !== i) onSelect?.(i); }}
            onContextMenu={(e) => handleContextMenu(e, i)}
            onDragStart={(e) => { setDragIdx(i); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => {
              if (dragIdx === null || dragIdx === i) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              setOverIdx(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) onReorder?.(dragIdx, i);
              setDragIdx(null); setOverIdx(null);
            }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            style={
              overIdx === i && dragIdx !== null && dragIdx !== i
                // Drop indicator on the side the dragged tab will land.
                ? { boxShadow: `inset ${dragIdx < i ? "-2px" : "2px"} 0 0 0 var(--accent)` }
                : dragIdx === i ? { opacity: 0.45 } : undefined
            }
          >
            <span className={"dot " + (t.state ?? "")} />

            {editingIdx === i ? (
              <input
                ref={editInputRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") setEditingIdx(null);
                }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontFamily: "var(--mono)", fontSize: 11.5,
                  background: "var(--bg-canvas)", color: "var(--fg)",
                  border: "1px solid var(--accent-dim)", borderRadius: 3,
                  padding: "1px 4px", width: 100, outline: "none",
                }}
              />
            ) : (
              <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(i); }}
              >
                {t.name}
              </span>
            )}

            <span style={{ color: "var(--fg-dim)", marginLeft: 4, fontSize: 10 }}>
              {t.layout}
            </span>
            <span
              className="x"
              onClick={(e) => { e.stopPropagation(); onClose?.(i); }}
            >
              ×
            </span>
          </div>
        ))}
        <button className="tab-add" onClick={onAdd}>+</button>
      </div>

      {contextMenu && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed", top: contextMenu.y, left: contextMenu.x, zIndex: 2000,
            background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
            minWidth: 210, overflow: "hidden", fontFamily: "var(--mono)",
          }}
        >
          {/* Rename row */}
          <button
            onClick={() => startRename(contextMenu.tabIdx)}
            style={{
              width: "100%", padding: "7px 12px", background: "transparent",
              border: "none", color: "var(--fg-muted)", fontSize: 11.5,
              textAlign: "left", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elev)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
          >
            <Pencil size={12} />
            Rename
          </button>

          <div style={{ height: 1, background: "var(--border-soft)", margin: "0 8px" }} />

          {/* Layout picker */}
          <div style={{ padding: "6px 12px 10px" }}>
            <div style={{
              fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 7,
              textTransform: "uppercase", letterSpacing: "0.07em",
            }}>
              Layout
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {LAYOUTS.map((l) => {
                const [c, r] = l.split("×").map(Number);
                const current = tabs[contextMenu.tabIdx]?.layout === l;
                return (
                  <button
                    key={l}
                    onClick={() => { onChangeLayout?.(contextMenu.tabIdx, l); setContextMenu(null); }}
                    title={l}
                    style={{
                      padding: "5px 7px", borderRadius: 4, cursor: "pointer",
                      fontFamily: "var(--mono)", fontSize: 10,
                      background: current
                        ? "color-mix(in oklch, var(--accent), transparent 85%)"
                        : "var(--bg-elev)",
                      border: "1px solid " + (current ? "var(--accent-dim)" : "var(--border-soft)"),
                      color: current ? "var(--accent)" : "var(--fg-muted)",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (!current) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elev2)";
                    }}
                    onMouseLeave={(e) => {
                      if (!current) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elev)";
                    }}
                  >
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${c}, 8px)`,
                      gridTemplateRows: `repeat(${r}, 5px)`,
                      gap: 1.5,
                    }}>
                      {Array.from({ length: c * r }).map((_, idx) => (
                        <div key={idx} style={{
                          borderRadius: 1,
                          background: current ? "var(--accent)" : "var(--border)",
                        }} />
                      ))}
                    </div>
                    {l}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
