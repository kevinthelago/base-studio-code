import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { type ViewKey } from "./ViewTabs";
import { PaneMenu, type ModelId } from "./PaneMenu";
import { prettyModel, toModelId } from "../../lib/console/modelDisplay";

// The canonical pane-status vocabulary lives in lib/paneStatus (#435); re-exported
// here so existing PaneShell importers keep their import path.
export type { PaneStatus } from "../../lib/console/paneStatus";
import type { PaneStatus } from "../../lib/console/paneStatus";

// Session-state vocabulary → the footer/dot label + the themed state color (#1149). Our live
// status is "run" | "on" | "idle"; a disabled pane arrives as "idle" but is labelled "stopped".
const STATE_META: Record<string, { label: string; color: string; pulse: boolean }> = {
  run:  { label: "running", color: "var(--state-run)", pulse: true },
  on:   { label: "ready",   color: "var(--state-run)", pulse: false },
  idle: { label: "idle",    color: "var(--state-idle)", pulse: false },
};

// LLM-provider → its themed hue (the dot in the model pill) and the harness it runs under.
// Absent / "claude" ⇒ Claude Code (anthropic); everything else runs under the bsc-agent shell.
const PROV_COLOR: Record<string, string> = {
  claude: "var(--prov-anthropic)", anthropic: "var(--prov-anthropic)",
  openai: "var(--prov-openai)", codex: "var(--prov-openai)",
  gemini: "var(--prov-google)", google: "var(--prov-google)",
  local: "var(--prov-local)", ollama: "var(--prov-local)",
};
const harnessOf = (provider?: string) =>
  !provider || provider === "claude" || provider === "anthropic" ? "Claude Code" : "bsc-agent";

interface PaneShellProps {
  agent: string;
  status?: PaneStatus;
  meta?: string;
  model?: ModelId;
  /** Repo this pane works in (short `name`, not `owner/name`) — shown after the agent name. */
  repo?: string;
  /** Current branch — shown in the footer. */
  branch?: string;
  /** Session role (worker/director/…) — shown as a header badge. */
  role?: string;
  /** LLM provider id — drives the model-pill dot color + the harness label. */
  provider?: string;
  /** The actual model the running CLI reports (#1181, from its transcript). When known it's shown
   *  in the model pill instead of the configured `model`; absent ⇒ fall back to `model`. */
  runningModel?: string;
  /** Uncommitted-change count — a header badge when > 0. */
  changes?: number;
  /** Warning count — a header badge when > 0. */
  warns?: number;
  /** Session token + cost rollups — shown in the footer when known. */
  tok?: string;
  cost?: string;
  /** A Claude session is active in this pane (#1158): the native console input stands in for the
   *  status footer, so the footer is hidden to make room for it. */
  claudeActive?: boolean;
  available?: ViewKey[];
  active?: ViewKey;
  banner?: React.ReactNode;
  menuOpen?: boolean;
  focused?: boolean;
  fullscreen?: boolean;
  disabled?: boolean;
  /** Hidden but kept mounted (e.g. a non-maximized pane while another is fullscreen). */
  hidden?: boolean;
  onViewChange?: (view: ViewKey) => void;
  onMenuToggle?: () => void;
  onToggleFullscreen?: () => void;
  onToggleDisable?: () => void;
  /** Force a TUI repaint of this pane via a resize nudge (#1221). */
  onRedraw?: () => void;
  onFocus?: () => void;
  onRename?: (name: string) => void;
  onPickDirectory?: () => void;
  onModel?: (model: ModelId) => void;
  children: React.ReactNode;
}

export function PaneShell({
  agent,
  status = "run",
  model = "sonnet-4.5",
  repo,
  role,
  provider,
  changes = 0,
  warns = 0,
  claudeActive = false,
  runningModel,
  available = ["console", "files"],
  active = "console",
  banner,
  menuOpen = false,
  focused = false,
  fullscreen = false,
  disabled = false,
  hidden = false,
  onViewChange,
  onMenuToggle,
  onToggleFullscreen,
  onToggleDisable,
  onRedraw,
  onFocus,
  onRename,
  onPickDirectory,
  onModel,
  children,
}: PaneShellProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<
    { right: number; maxHeight: number; top?: number; bottom?: number } | null
  >(null);

  // Position the menu from the button when it opens. Open toward whichever side
  // has more room (so lower panes flip the menu UPWARD instead of clipping off
  // the bottom of the window) and cap its height to the available space so it
  // scrolls rather than overflowing the window edge.
  useEffect(() => {
    if (menuOpen && menuButtonRef.current) {
      const r = menuButtonRef.current.getBoundingClientRect();
      const margin = 8;
      const right = window.innerWidth - r.right;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      if (spaceBelow >= spaceAbove) {
        setMenuPos({ top: r.bottom + 4, right, maxHeight: spaceBelow });
      } else {
        setMenuPos({ bottom: window.innerHeight - r.top + 4, right, maxHeight: spaceAbove });
      }
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

  const sm = STATE_META[status] ?? STATE_META.idle;
  const provColor = PROV_COLOR[provider ?? "claude"] ?? "var(--prov-local)";
  const harness = harnessOf(provider);
  // Model-pill state (#1181): a model is "running" when a Claude session is live in the pane
  // (`claudeActive`, from the OSC-100 signals); otherwise the pill shows an undetected/empty state.
  // `runningModel` is the actual model the CLI reports (transcript) when known, else the configured
  // one; absent ⇒ fall back to the configured `model`.
  const running = claudeActive;
  const modelLabel = prettyModel(runningModel) ?? model;

  const chip = (txt: string, bg: string, col: string) => (
    <span style={{ padding: "0 4px", borderRadius: 5, background: bg, color: col, fontSize: 9, fontFamily: "var(--mono)" }}>{txt}</span>
  );

  return (
    <div
      ref={paneRef}
      className={focused ? "pane focused" : "pane"}
      onClick={onFocus}
      style={{
        height: "100%",
        // Hidden panes stay mounted (xterm/PTY/scrollback preserved) — just not displayed.
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        position: "relative",
        zIndex: menuOpen ? 10 : 1,
      }}
    >
      {/* Head — the Console-Shell pane header (#1149): status · name · repo · badges,
          then the view-switch ▾, harness/model pill, role badge, and ⋯ menu. */}
      <div style={{
        height: 36, flex: "0 0 36px", padding: "0 10px",
        display: "flex", alignItems: "center", gap: 7,
        background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)",
      }}>

        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: sm.color,
          animation: sm.pulse ? "pulse 1.6s ease-in-out infinite" : "none", flex: "0 0 7px",
        }} />

        {/* Agent name — double-click to rename */}
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
              fontFamily: "var(--mono)", fontSize: 12,
              background: "var(--bg-canvas)", color: "var(--fg)",
              border: "1px solid var(--accent-dim)", borderRadius: 3,
              padding: "1px 5px", width: 130, outline: "none", flex: "0 0 auto",
            }}
          />
        ) : (
          <span
            onDoubleClick={() => { setDraftName(agent); setEditingName(true); }}
            title="Double-click to rename"
            style={{
              fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)",
              whiteSpace: "nowrap", flex: "0 0 auto",
            }}
          >{agent}</span>
        )}

        {/* Repo */}
        {repo && (
          <span style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 1 auto", minWidth: 0,
          }}>· {repo}</span>
        )}

        {/* Change / warn badges */}
        {changes > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 10, flex: "0 0 auto" }}>
            ±{chip(String(changes), "var(--bg-elev2)", "var(--fg-muted)")}
          </span>
        )}
        {warns > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--state-wait)", fontFamily: "var(--mono)", fontSize: 10, flex: "0 0 auto" }}>
            ⚠{chip(String(warns), "color-mix(in oklch, var(--danger), transparent 82%)", "var(--danger)")}
          </span>
        )}

        {/* Spacer pushes the controls to the right edge */}
        <div style={{ flex: 1, minWidth: 0 }} />

        {/* Model pill — the SINGLE consolidated menu trigger (#1181): model · screens · pane
            actions all live in the one PaneMenu it opens. Shows the running model when live, else
            the configured model the pane will launch with (#…). */}
        <button
          ref={menuButtonRef}
          title="Model, screens & pane options"
          onClick={onMenuToggle}
          style={{
            display: "flex", alignItems: "center", gap: 5, height: 21, padding: "0 8px",
            border: "1px solid " + (menuOpen ? "var(--accent)" : "var(--border)"), borderRadius: 6,
            background: menuOpen ? "var(--bg-canvas)" : "var(--bg-panel)",
            color: "var(--fg)", cursor: "pointer", flex: "0 0 auto", whiteSpace: "nowrap",
          }}
        >
          {running ? (
            <>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: provColor }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{harness}</span>
              <span style={{ color: "var(--fg-dim)" }}>·</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{modelLabel}</span>
            </>
          ) : (
            // Idle / not yet live: show the CONFIGURED model (what this pane will launch with) so the
            // chosen model is always legible on the grid, rather than a bare "undetected" (#…). The
            // gray dot still signals the session isn't live.
            <>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--state-idle)" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{model}</span>
            </>
          )}
          <span style={{ color: menuOpen ? "var(--accent-text)" : "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 }}>▾</span>
        </button>

        {/* Role badge */}
        {role && (
          <span style={{
            height: 21, padding: "0 7px", display: "flex", alignItems: "center", borderRadius: 6,
            background: role === "director" ? "var(--accent-soft)" : "var(--bg-elev2)",
            color: role === "director" ? "var(--accent-text)" : "var(--fg-muted)",
            fontFamily: "var(--mono)", fontSize: 10, fontWeight: 600, letterSpacing: ".03em",
            flex: "0 0 auto", whiteSpace: "nowrap",
          }}>{role.toUpperCase()}</span>
        )}
      </div>

      {banner}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>

      {menuOpen && menuPos && createPortal(
        <div ref={menuRef} style={{
          position: "fixed",
          right: menuPos.right,
          ...(menuPos.top !== undefined ? { top: menuPos.top } : { bottom: menuPos.bottom }),
          zIndex: 1000,
        }}>
          <PaneMenu
            agent={agent}
            model={model} runningModel={toModelId(runningModel)} active={active} available={available}
            maxHeight={menuPos.maxHeight}
            fullscreen={fullscreen}
            disabled={disabled}
            onToggleFullscreen={onToggleFullscreen}
            onToggleDisable={onToggleDisable}
            onRedraw={onRedraw}
            onPickDirectory={onPickDirectory}
            onClose={onMenuToggle}
            onRename={() => { setDraftName(agent); setEditingName(true); onMenuToggle?.(); }}
            onViewChange={onViewChange}
            onModel={onModel}
          />
        </div>,
        document.body
      )}
    </div>
  );
}
