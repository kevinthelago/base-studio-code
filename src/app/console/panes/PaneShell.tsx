import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { type ViewKey, VIEW_DEFS } from "./ViewTabs";
import { PaneMenu, type ModelId } from "./PaneMenu";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { toModelId } from "@/app/console/lib/modelDisplay";

// The canonical pane-status vocabulary lives in lib/paneStatus (#435); re-exported
// here so existing PaneShell importers keep their import path.
export type { PaneStatus } from "@/app/console/lib/paneStatus";
import type { PaneStatus } from "@/app/console/lib/paneStatus";

// Session-state vocabulary → the footer/dot label + the themed state color (#1149). Our live
// status is "run" | "on" | "idle"; a disabled pane arrives as "idle" but is labelled "stopped".
const STATE_META: Record<string, { label: string; color: string; pulse: boolean }> = {
  run:  { label: "running", color: "var(--state-run)", pulse: true },
  on:   { label: "ready",   color: "var(--state-run)", pulse: false },
  idle: { label: "idle",    color: "var(--state-idle)", pulse: false },
};

// The provider hue (`PROV_COLOR`) + harness label that once tinted the header pill now live
// inside `PaneMenu` (#1319) — the compact header trigger is tinted by SESSION STATUS, not
// provider. They stay on PaneShell as the source the menu reads via props.

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
  /** A Claude session is live in this pane (from the OSC-100 run/idle signals). Drives the
   *  model-pill "running" indicator (#1181). */
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
  const [menuPos, setMenuPos] = useState<MenuPlacement | null>(null);

  // Position the menu so it stays fully on-screen (#1374). We MEASURE the menu's actual size
  // (the portal renders hidden first, so `menuRef` has real dimensions here) and hand it +
  // the trigger rect to the pure `placeMenu`, which picks a top/left clamped into the viewport
  // on all four sides and caps the height to the available space. Recomputes on resize while
  // open. `useLayoutEffect` runs before paint, so the hidden→placed flip never flickers.
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuPos(null); return; }
    const compute = () => {
      const btn = menuButtonRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!btn || !menu) return;
      setMenuPos(placeMenu(
        btn,
        { width: menu.width, height: menu.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
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
  // The compact header trigger (#1319) is the CURRENT VIEW's icon tinted by SESSION STATUS:
  // accent + pulse when a session is live (`claudeActive`), the themed state color otherwise.
  // The harness/provider/model the pill once spelled out now live inside `PaneMenu`.
  const running = claudeActive;
  const { Icon: ViewIcon } = VIEW_DEFS[active] ?? VIEW_DEFS.console;
  const triggerColor = running ? "var(--accent)" : sm.color;

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
      {/* Head — the Console-Shell pane header (#1149, reworked #1319): the compact menu trigger
          (current-view glyph tinted by status + ▾) at the far left · name · repo · badges, then
          the role badge. Model/harness/view-switching all live inside the menu the trigger opens. */}
      <div style={{
        height: 36, flex: "0 0 36px", padding: "0 10px",
        display: "flex", alignItems: "center", gap: 7,
        background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)",
      }}>

        {/* Menu trigger (#1319) — the leftmost control, where the status dot used to be. A single
            glyph = the CURRENT view's icon (console/files/branches/…) tinted by SESSION STATUS
            (accent + pulse when live, the state color when idle) + a ▾. One compact control answers
            "what am I looking at" + "is it live" and signals the menu (model · views · pane) opens. */}
        <button
          ref={menuButtonRef}
          title="Model, screens & pane options"
          onClick={onMenuToggle}
          style={{
            display: "flex", alignItems: "center", gap: 3, height: 21, padding: "0 5px",
            border: "1px solid " + (menuOpen ? "var(--accent)" : "var(--border)"), borderRadius: 6,
            background: menuOpen ? "var(--bg-canvas)" : "var(--bg-panel)",
            cursor: "pointer", flex: "0 0 auto",
          }}
        >
          <ViewIcon
            size={13}
            style={{
              color: triggerColor,
              animation: running && sm.pulse ? "pulse 1.6s ease-in-out infinite" : "none",
            }}
          />
          <span style={{ color: menuOpen ? "var(--accent-text)" : "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 }}>▾</span>
        </button>

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

        {/* Spacer pushes the role badge to the right edge */}
        <div style={{ flex: 1, minWidth: 0 }} />

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

      {menuOpen && createPortal(
        <div ref={menuRef} style={{
          position: "fixed",
          // Hidden for the first (measure) pass, then placed; off-screen meanwhile so the
          // hidden element can't catch clicks or show a flash at 0,0.
          left: menuPos ? menuPos.left : -9999,
          top: menuPos ? menuPos.top : -9999,
          visibility: menuPos ? "visible" : "hidden",
          zIndex: 1000,
        }}>
          <PaneMenu
            agent={agent}
            provider={provider} running={running}
            model={model} runningModel={toModelId(runningModel)} active={active} available={available}
            maxHeight={menuPos?.maxHeight}
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
