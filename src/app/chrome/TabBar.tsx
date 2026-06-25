// TabBar -- the one shared tab strip used by every page (#463). Encapsulates the
// whole tab interaction model so it lives in exactly one place:
//   • select / add / close
//   • inline rename (optional)
//   • a context menu (optional, via renderMenu — e.g. the console layout picker)
//   • drag-to-reorder (full-width drop zone + insertion bar + strip highlight)
//   • tear-off: drag a tab out of the strip → a floating preview → onTearOff
//
// It's generic over a TabItem; pages pass only the affordances they support. The
// console configures all of them; section pages typically pass select + tearOff.

import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TabItem {
  /** Stable identity used for selection, reorder targets, and tear-off. */
  id: string;
  label: string;
  /** Small sub-label shown after the label (section pages). */
  hint?: string;
  /** Badge count shown after the label. */
  count?: number;
  /** Status dot (console run/on/idle). */
  status?: "run" | "on" | "idle";
  /** Trailing meta text (e.g. the console layout "2×2"). */
  meta?: string;
}

export interface TabBarProps {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Reorder a tab from index `from` to `to`. Omit to disable reordering. */
  onReorder?: (from: number, to: number) => void;
  /** Tear a tab into a new window — fired when dropped outside the strip. */
  onTearOff?: (id: string) => void;
  onClose?: (id: string) => void;
  onAdd?: () => void;
  onRename?: (id: string, name: string) => void;
  /** Context-menu body for a tab (e.g. the layout picker). `ctx.startRename`
   *  enters TabBar's inline rename for that tab; `ctx.close` dismisses the menu. */
  renderMenu?: (id: string, ctx: { close: () => void; startRename: () => void }) => ReactNode;
  /** Trailing actions/stats rendered at the right end of the strip. */
  right?: ReactNode;
}

export function TabBar({
  tabs, activeId, onSelect, onReorder, onTearOff, onClose, onAdd, onRename, renderMenu, right,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropPos, setDropPos] = useState<number | null>(null);
  const [tearOff, setTearOff] = useState<{ x: number; y: number } | null>(null);

  const editRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (editingId !== null) editRef.current?.select(); }, [editingId]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [menu]);

  const commitRename = useCallback(() => {
    if (editingId === null) return;
    const t = editingName.trim();
    if (t) onRename?.(editingId, t);
    setEditingId(null);
  }, [editingId, editingName, onRename]);

  const dropGapFor = useCallback((clientX: number): number => {
    const els = stripRef.current?.querySelectorAll<HTMLElement>("[data-tab]");
    if (!els) return 0;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  }, []);

  const endDrag = useCallback(() => { setDragIdx(null); setDropPos(null); setTearOff(null); }, []);

  function commitDrop() {
    if (dragIdx !== null && dropPos !== null) {
      const target = dropPos > dragIdx ? dropPos - 1 : dropPos;
      if (target !== dragIdx) onReorder?.(dragIdx, target);
    }
    endDrag();
  }

  // App-wide watch while dragging: outside the strip → tear-off preview; dropping
  // outside → onTearOff. Inside drops are handled by the strip's own handlers.
  useEffect(() => {
    if (dragIdx === null) return;
    const M = 10;
    const outside = (e: { clientX: number; clientY: number }, r: DOMRect) =>
      e.clientX < r.left - M || e.clientX > r.right + M ||
      e.clientY < r.top - M || e.clientY > r.bottom + M;
    const over = (e: DragEvent) => {
      const r = stripRef.current?.getBoundingClientRect();
      if (!r) return;
      if (outside(e, r) && onTearOff) {
        e.preventDefault();
        setDropPos(null);
        setTearOff({ x: e.clientX, y: e.clientY });
      } else {
        setTearOff(null);
      }
    };
    const drop = (e: DragEvent) => {
      const r = stripRef.current?.getBoundingClientRect();
      if (r && onTearOff && outside(e, r) && dragIdx !== null) {
        e.preventDefault();
        onTearOff(tabs[dragIdx]?.id);
      }
      endDrag();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, [dragIdx, onTearOff, endDrag, tabs]);

  function tabDragStyle(i: number): CSSProperties | undefined {
    const dim: CSSProperties = dragIdx === i ? { opacity: 0.4 } : {};
    if (dragIdx === null || dropPos === null) return Object.keys(dim).length ? dim : undefined;
    if (dropPos === i) return { ...dim, boxShadow: "-2px 0 0 0 var(--accent)" };
    if (dropPos === tabs.length && i === tabs.length - 1) return { ...dim, boxShadow: "2px 0 0 0 var(--accent)" };
    return Object.keys(dim).length ? dim : undefined;
  }

  const canDrag = !!onReorder || !!onTearOff;

  return (
    <>
      <div
        ref={stripRef}
        className={"tabstrip" + (dragIdx !== null ? " dragging" : "")}
        onDragOver={(e) => { if (dragIdx === null) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; setDropPos(dropGapFor(e.clientX)); }}
        onDrop={(e) => { if (dragIdx === null) return; e.preventDefault(); commitDrop(); }}
      >
        {tabs.map((t, i) => (
          <div
            key={t.id}
            data-tab
            className={"tab " + (t.id === activeId ? "active" : "")}
            // Both hint and meta are tooltip-only (#488) — never inline text — so they
            // never compete with the label for the tab's width cap.
            // hint uses em-dash (label — hint); meta appends with · (…label · meta).
            title={[t.hint ? `${t.label} — ${t.hint}` : t.label, t.meta].filter(Boolean).join(" · ")}
            draggable={canDrag && editingId !== t.id}
            onClick={() => { if (editingId !== t.id) onSelect(t.id); }}
            onContextMenu={renderMenu ? (e) => {
              e.preventDefault();
              setMenu({ id: t.id, x: Math.min(e.clientX, window.innerWidth - 228), y: e.clientY });
            } : undefined}
            onDragStart={(e) => {
              setDragIdx(i); setDropPos(i);
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                const img = new Image();
                img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                e.dataTransfer.setDragImage(img, 0, 0);
              }
            }}
            onDragEnd={endDrag}
            style={tabDragStyle(i)}
          >
            {t.status !== undefined && <span className={"dot " + t.status} />}
            {editingId === t.id ? (
              <input
                ref={editRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--bg-canvas)",
                  color: "var(--fg)", border: "1px solid var(--accent-dim)", borderRadius: 3,
                  padding: "1px 4px", width: 100, outline: "none",
                }}
              />
            ) : (
              <span
                // Flex-shrinkable so the title (not a trailing element) ellipsizes
                // when the tab hits its width cap.
                style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                onDoubleClick={onRename ? (e) => { e.stopPropagation(); setEditingId(t.id); setEditingName(t.label); } : undefined}
              >
                {t.label}
              </span>
            )}
            {t.count !== undefined && <span className="count">{t.count}</span>}
            {onClose && (
              <span className="x" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</span>
            )}
          </div>
        ))}
        {onAdd && <button className="tab-add" onClick={onAdd}>+</button>}
        {right && <><span style={{ flex: 1 }} /><span className="tabbar-right">{right}</span></>}
      </div>

      {tearOff && dragIdx !== null && createPortal(
        <div className="tab-tearoff-preview" style={{ position: "fixed", left: tearOff.x + 14, top: tearOff.y + 14, zIndex: 3000, pointerEvents: "none" }}>
          <div className="ttp-bar">
            <span className="ttp-light" /><span className="ttp-light" /><span className="ttp-light" />
            <span className="ttp-title">{tabs[dragIdx]?.label}</span>
          </div>
          <div className="ttp-body"><span className="ttp-hint">↗ release to open in a new window</span></div>
        </div>,
        document.body,
      )}

      {menu && renderMenu && createPortal(
        <div ref={menuRef} style={{
          position: "fixed", top: menu.y, left: menu.x, zIndex: 2000,
          background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
          minWidth: 210, overflow: "hidden", fontFamily: "var(--mono)",
        }}>
          {renderMenu(menu.id, {
            close: () => setMenu(null),
            startRename: () => {
              const t = tabs.find((x) => x.id === menu.id);
              setEditingId(menu.id); setEditingName(t?.label ?? ""); setMenu(null);
            },
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
