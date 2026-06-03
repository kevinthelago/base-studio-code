import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
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
  /** Tear off a tab into a new window — fired when it's dropped outside the strip. */
  onTearOff?: (idx: number) => void;
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
  onTearOff,
}: TabstripProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Drag-to-reorder: index being dragged, and the insertion gap (0..tabs.length)
  // the cursor is over. The whole strip is the drop zone so a tab can be moved
  // anywhere, including past the last tab (gap === tabs.length).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropPos, setDropPos] = useState<number | null>(null);
  // When the dragged tab is pulled OUT of the strip, this holds the cursor
  // position and we render a floating "new window" preview there. Dropping while
  // torn off will open the tab in its own window (#430); coming back into the
  // strip cancels the tear-off and resumes reordering.
  const [tearOff, setTearOff] = useState<{ x: number; y: number } | null>(null);

  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Which insertion gap is the cursor nearest? Compares clientX to each tab's
  // horizontal midpoint; returns tabs.length when past the last tab.
  const dropGapFor = useCallback((clientX: number): number => {
    const els = stripRef.current?.querySelectorAll<HTMLElement>(".tab");
    if (!els) return 0;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  }, []);

  const endDrag = useCallback(() => { setDragIdx(null); setDropPos(null); setTearOff(null); }, []);

  // While a tab is being dragged, watch the cursor app-wide (HTML5 dragover fires
  // over every element). When it leaves the strip's box, enter tear-off mode and
  // show the floating preview; when it re-enters, cancel it and resume reordering.
  useEffect(() => {
    if (dragIdx === null) return;
    const M = 10; // small slack around the strip so the edge isn't twitchy
    const outside = (e: { clientX: number; clientY: number }, r: DOMRect) =>
      e.clientX < r.left - M || e.clientX > r.right + M ||
      e.clientY < r.top - M || e.clientY > r.bottom + M;
    const onWinDragOver = (e: DragEvent) => {
      const r = stripRef.current?.getBoundingClientRect();
      if (!r) return;
      if (outside(e, r)) {
        e.preventDefault(); // allow the drop-to-open-window outside the strip
        setDropPos(null);
        setTearOff({ x: e.clientX, y: e.clientY });
      } else {
        setTearOff(null);
      }
    };
    // Dropping outside the strip tears the tab off into a new window; inside
    // drops are handled by the strip's own onDrop (reorder).
    const onWinDrop = (e: DragEvent) => {
      const r = stripRef.current?.getBoundingClientRect();
      if (r && outside(e, r) && dragIdx !== null) {
        e.preventDefault();
        onTearOff?.(dragIdx);
      }
      endDrag();
    };
    window.addEventListener("dragover", onWinDragOver);
    window.addEventListener("drop", onWinDrop);
    return () => {
      window.removeEventListener("dragover", onWinDragOver);
      window.removeEventListener("drop", onWinDrop);
    };
  }, [dragIdx, onTearOff, endDrag]);

  function commitDrop() {
    if (dragIdx !== null && dropPos !== null) {
      // A gap after the dragged tab maps one lower once it's removed.
      const target = dropPos > dragIdx ? dropPos - 1 : dropPos;
      if (target !== dragIdx) onReorder?.(dragIdx, target);
    }
    endDrag();
  }

  // Per-tab drag styling: dim the tab being dragged, and draw the insertion bar
  // on the edge nearest the drop gap (left of tab[dropPos], or right of the last
  // tab when dropping at the end). Drawn as an outset box-shadow so it adds no
  // DOM node — keeps the tab elements stable across the drag.
  function tabDragStyle(i: number): CSSProperties | undefined {
    const dim: CSSProperties = dragIdx === i ? { opacity: 0.4 } : {};
    if (dragIdx === null || dropPos === null) return Object.keys(dim).length ? dim : undefined;
    if (dropPos === i) return { ...dim, boxShadow: "-2px 0 0 0 var(--accent)" };
    if (dropPos === tabs.length && i === tabs.length - 1) return { ...dim, boxShadow: "2px 0 0 0 var(--accent)" };
    return Object.keys(dim).length ? dim : undefined;
  }

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
      <div
        ref={stripRef}
        className={"tabstrip" + (dragIdx !== null ? " dragging" : "")}
        // The entire strip is the drop zone (full width), so a tab can be moved
        // anywhere — including the empty space past the last tab.
        onDragOver={(e) => {
          if (dragIdx === null) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          setDropPos(dropGapFor(e.clientX));
        }}
        onDrop={(e) => { if (dragIdx === null) return; e.preventDefault(); commitDrop(); }}
      >
        {tabs.map((t, i) => (
          <div
            key={i}
            className={"tab " + (i === activeIdx ? "active" : "")}
            // Disable drag while renaming so the input stays text-selectable.
            draggable={editingIdx !== i}
            onClick={() => { if (editingIdx !== i) onSelect?.(i); }}
            onContextMenu={(e) => handleContextMenu(e, i)}
            onDragStart={(e) => {
              setDragIdx(i); setDropPos(i);
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                // Hide the browser's default drag ghost so our own preview shows.
                const img = new Image();
                img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                e.dataTransfer.setDragImage(img, 0, 0);
              }
            }}
            onDragEnd={endDrag}
            style={tabDragStyle(i)}
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

      {/* Tear-off preview — a floating "new window" mock following the cursor
          while the tab is dragged outside the strip. Dropping here will open the
          tab in its own window (#430). */}
      {tearOff && dragIdx !== null && createPortal(
        <div
          className="tab-tearoff-preview"
          style={{ position: "fixed", left: tearOff.x + 14, top: tearOff.y + 14, zIndex: 3000, pointerEvents: "none" }}
        >
          <div className="ttp-bar">
            <span className="ttp-light" /><span className="ttp-light" /><span className="ttp-light" />
            <span className="ttp-title">{tabs[dragIdx]?.name}</span>
          </div>
          <div className="ttp-body">
            <span className="ttp-hint">↗ release to open in a new window</span>
          </div>
        </div>,
        document.body
      )}

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
