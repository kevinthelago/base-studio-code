import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, GitBranch, MoreHorizontal } from "lucide-react";
import { VIEW_DEFS, type ViewKey } from "./ViewTabs";
import { PaneMenu, type ModelId } from "./PaneMenu";

export type PaneStatus = "run" | "on" | "idle";

interface PaneShellProps {
  agent: string;
  status?: PaneStatus;
  meta?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  dirty?: boolean;
  model?: ModelId;
  available?: ViewKey[];
  active?: ViewKey;
  banner?: React.ReactNode;
  menuOpen?: boolean;
  focused?: boolean;
  onViewChange?: (view: ViewKey) => void;
  onMenuToggle?: () => void;
  onFocus?: () => void;
  onRename?: (name: string) => void;
  onPickDirectory?: () => void;
  children: React.ReactNode;
}

export function PaneShell({
  agent,
  status = "run",
  cwd: _cwd,
  repo,
  branch,
  dirty,
  model = "sonnet-4.5",
  available = ["console", "files"],
  active = "console",
  banner,
  menuOpen = false,
  focused = false,
  onViewChange,
  onMenuToggle,
  onFocus,
  onRename,
  onPickDirectory,
  children,
}: PaneShellProps) {
  const [viewOpen, setViewOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Compute fixed position from the button whenever the menu opens
  useEffect(() => {
    if (menuOpen && menuButtonRef.current) {
      const r = menuButtonRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
  }, [menuOpen]);

  // Close the pane menu on outside click, but let the button's own click handler toggle it
  useEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (menuButtonRef.current?.contains(e.target as Node)) return;
      if (!menuRef.current?.contains(e.target as Node)) onMenuToggle?.();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpen, onMenuToggle]);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(agent);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  const commitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== agent) onRename?.(trimmed);
    setEditingName(false);
  }, [draftName, agent, onRename]);

  useEffect(() => {
    if (!focused) return;
    const active = document.activeElement;
    if (paneRef.current?.contains(active)) return;
    const el = paneRef.current?.querySelector<HTMLElement>("textarea, input:not([type='hidden'])");
    el?.focus();
  }, [focused]);

  useEffect(() => {
    if (!viewOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!viewRef.current?.contains(e.target as Node)) setViewOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [viewOpen]);

  const statusColor =
    status === "idle" ? "var(--fg-dim)"
    : status === "run" ? "var(--accent)"
    : "var(--success)";

  const { Icon: ViewIcon, label: viewLabel } = VIEW_DEFS[active];

  return (
    <div
      ref={paneRef}
      className={focused ? "pane focused" : "pane"}
      onClick={onFocus}
      style={{
        height: "100%",
        display: "flex", flexDirection: "column",
        position: "relative",
        zIndex: menuOpen || viewOpen ? 10 : 1,
      }}
    >
      {/* Head */}
      <div style={{
        height: 32, flex: "0 0 32px", padding: "0 8px 0 6px",
        display: "flex", alignItems: "center", gap: 6,
        background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)",
      }}>

        {/* View selector dropdown */}
        <div ref={viewRef} style={{ position: "relative", flex: "0 0 auto" }}>
          <button
            title={`${viewLabel} · switch view`}
            onClick={() => setViewOpen(!viewOpen)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 22, borderRadius: 4,
              background: viewOpen ? "var(--bg-canvas)" : "transparent",
              border: `1px solid ${viewOpen ? "var(--accent-dim)" : "var(--border-soft)"}`,
              color: viewOpen ? "var(--accent)" : "var(--fg-muted)",
              cursor: "pointer",
            }}
          >
            <ViewIcon size={12} />
          </button>

          {viewOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0,
              zIndex: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)",
              minWidth: 170,
              boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
              overflow: "hidden",
              fontFamily: "var(--mono)",
            }}>
              {available.map((k) => {
                const { Icon, label, hotkey } = VIEW_DEFS[k];
                const on = k === active;
                return (
                  <div
                    key={k}
                    onClick={() => { onViewChange?.(k); setViewOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 10px",
                      cursor: "pointer",
                      background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent",
                      color: on ? "var(--accent)" : "var(--fg-muted)",
                    }}
                    onMouseEnter={(e) => {
                      if (!on) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elev)";
                    }}
                    onMouseLeave={(e) => {
                      if (!on) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                    }}
                  >
                    <span style={{ width: 14, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 14px" }}>
                      <Icon size={12} />
                    </span>
                    <span style={{ flex: 1, fontSize: 10.5 }}>{label}</span>
                    <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{hotkey}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: statusColor,
          animation: status === "run" ? "pulse 1.4s ease-in-out infinite" : "none",
          flex: "0 0 7px",
        }} />

        {/* Agent name — click to rename */}
        {editingName ? (
          <input
            ref={nameInputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
              if (e.key === "Escape") { setDraftName(agent); setEditingName(false); }
            }}
            style={{
              fontFamily: "var(--mono)", fontSize: 11.5,
              background: "var(--bg-canvas)", color: "var(--fg)",
              border: "1px solid var(--accent-dim)", borderRadius: 3,
              padding: "1px 5px", width: 130, outline: "none", flex: "0 0 auto",
            }}
          />
        ) : (
          <span
            onClick={() => { setDraftName(agent); setEditingName(true); }}
            title="Click to rename"
            style={{
              fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 1 auto",
              cursor: "text",
            }}
          >{agent}</span>
        )}

        {/* Repo / branch — only shown when a repo is attached */}
        <div style={{
          flex: 1, minWidth: 0,
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)",
          whiteSpace: "nowrap", overflow: "hidden",
        }}>
          {repo && (
            <>
              <span style={{ color: "var(--info)", display: "flex", alignItems: "center", gap: 3, flex: "0 0 auto" }}>
                <GitBranch size={10} /> {branch}
              </span>
              {dirty && <span style={{ color: "var(--danger)", flex: "0 0 auto" }}>●</span>}
              <span style={{ color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis" }}>{repo}</span>
            </>
          )}
        </div>

        {/* Open directory */}
        <button
          title="Open project directory"
          onClick={onPickDirectory}
          style={{
            width: 22, height: 22, borderRadius: 4,
            border: "1px solid transparent",
            background: "transparent",
            color: "var(--fg-muted)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", flex: "0 0 22px",
          }}
        >
          <FolderOpen size={12} />
        </button>

        {/* More options */}
        <button
          ref={menuButtonRef}
          title="Pane menu"
          onClick={onMenuToggle}
          style={{
            width: 22, height: 22, borderRadius: 4,
            border: "1px solid " + (menuOpen ? "var(--accent-dim)" : "transparent"),
            background: menuOpen ? "var(--bg-canvas)" : "transparent",
            color: menuOpen ? "var(--accent)" : "var(--fg-muted)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", flex: "0 0 22px",
          }}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>

      {banner}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>

      {menuOpen && menuPos && createPortal(
        <div ref={menuRef} style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 1000 }}>
          <PaneMenu
            agent={agent} repo={repo} branch={branch}
            model={model} active={active} available={available}
            onClose={onMenuToggle}
            onRename={() => { setDraftName(agent); setEditingName(true); onMenuToggle?.(); }}
            onViewChange={onViewChange}
          />
        </div>,
        document.body
      )}
    </div>
  );
}
