import { useState } from "react";
import { Maximize2, Minimize2, Power, PowerOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type ViewKey, VIEW_DEFS } from "./ViewTabs";

export type ModelId = "haiku-4.5" | "sonnet-4.5" | "opus-4.5";

const MODELS: Array<{ id: ModelId; tone: string; price: string }> = [
  { id: "haiku-4.5",  tone: "fast",     price: "$"   },
  { id: "sonnet-4.5", tone: "balanced", price: "$$"  },
  { id: "opus-4.5",   tone: "deep",     price: "$$$" },
];

interface PaneMenuProps {
  agent: string;
  /** The model configured for this pane (what `claude --model` launches next). */
  model: ModelId;
  /** The model the CLI is ACTUALLY running right now (mapped from the transcript, #1181), when
   *  known and a Claude family the menu offers. Drives the selected highlight so the menu
   *  reflects reality; absent ⇒ fall back to the configured `model`. */
  runningModel?: ModelId;
  active: ViewKey;
  available: ViewKey[];
  /** Caps the menu height so it scrolls instead of clipping past the window edge. */
  maxHeight?: number;
  /** Whether this pane is currently maximized (fullscreen). */
  fullscreen?: boolean;
  /** Whether this pane's console is currently disabled (PTY stopped). */
  disabled?: boolean;
  onToggleFullscreen?: () => void;
  onToggleDisable?: () => void;
  /** Open the directory picker to change this pane's working dir (moved here from the header). */
  onPickDirectory?: () => void;
  onClose?: () => void;
  onRename?: () => void;
  onViewChange?: (view: ViewKey) => void;
  /** Set this pane's model. Applies to `claude --model` on the pane's next launch. */
  onModel?: (model: ModelId) => void;
}

export function PaneMenu({
  agent, model, runningModel, active, available, maxHeight, fullscreen, disabled,
  onToggleFullscreen, onToggleDisable, onClose, onRename, onViewChange, onModel,
}: PaneMenuProps) {
  // The highlighted row reflects what's ACTUALLY running when known (#1181), else the
  // configured model. Selecting a different row still sets the model for the next launch.
  const selected = runningModel ?? model;
  return (
    <div style={{
      width: 268,
      maxHeight,
      background: "var(--bg-panel)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02)",
      // Scroll vertically (capped by maxHeight) but keep rounded corners; the menu's
      // own drop shadow is unaffected since overflow only clips descendants.
      overflowX: "hidden", overflowY: "auto",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      {/* Header */}
      <div style={{
        padding: "10px 12px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{agent}</span>
          <span style={{ flex: 1 }} />
          <span
            style={{ color: "var(--fg-dim)", fontSize: 10, cursor: "pointer" }}
            onClick={onRename}
          >rename</span>
        </div>
      </div>

      {/* Model */}
      <MenuSection label="model">
        {MODELS.map((m) => {
          const on = m.id === selected;
          const isRunning = runningModel != null && m.id === runningModel;
          return (
            <MenuRow key={m.id} on={on} onClick={onModel ? () => { onModel(m.id); onClose?.(); } : undefined}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: on ? "var(--accent)" : "var(--border)",
              }} />
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{m.id}</span>
              {isRunning && <span style={{ color: "var(--accent)", fontSize: 9, marginRight: 6 }}>running</span>}
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5, marginRight: 6 }}>{m.tone}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5, fontFamily: "var(--sans)" }}>{m.price}</span>
            </MenuRow>
          );
        })}
        <div style={{ padding: "4px 8px 0", fontSize: 9, color: "var(--fg-dim)" }}>
          applies on the pane's next launch (disable → enable to apply now)
        </div>
      </MenuSection>

      {/* Views */}
      <MenuSection label="view">
        {available.map((k) => {
          const { Icon, label, hotkey } = VIEW_DEFS[k];
          const on = k === active;
          return (
            <MenuRow key={k} on={on} onClick={() => { onViewChange?.(k); onClose?.(); }}>
              <Icon size={12} style={{ flexShrink: 0, color: on ? "var(--accent)" : "var(--fg-muted)" }} />
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{label}</span>
              {on && <span style={{ color: "var(--accent)", fontSize: 9.5, marginRight: 6 }}>current</span>}
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{hotkey}</span>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Pane actions */}
      <MenuSection label="pane" last>
        <ActionRow
          Icon={fullscreen ? Minimize2 : Maximize2}
          label={fullscreen ? "minimize pane" : "maximize pane"}
          sub={fullscreen ? "back to grid" : "fill the tab"}
          onClick={() => { onToggleFullscreen?.(); onClose?.(); }}
        />
        <ActionRow
          Icon={disabled ? Power : PowerOff}
          label={disabled ? "enable console" : "disable console"}
          sub={disabled ? "restart session" : "stop session"}
          danger={!disabled}
          onClick={() => { onToggleDisable?.(); onClose?.(); }}
        />
      </MenuSection>
    </div>
  );
}

function MenuSection({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ padding: "6px 6px", borderBottom: last ? "0" : "1px solid var(--border-soft)" }}>
      <div style={{
        padding: "4px 8px 6px", fontSize: 9.5, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".08em",
      }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>{children}</div>
    </div>
  );
}

function MenuRow({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const bg = on
    ? "color-mix(in oklch, var(--accent), transparent 90%)"
    : hovered ? "var(--bg-elev2)" : "transparent";
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
        borderRadius: 5, background: bg, cursor: "pointer",
        transition: "background 0.08s",
      }}
    >{children}</div>
  );
}

function ActionRow({ Icon, label, sub, danger, onClick }: {
  Icon: LucideIcon; label: string; sub: string; danger?: boolean; onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
        borderRadius: 5, cursor: "pointer",
        background: hovered
          ? danger ? "color-mix(in oklch, var(--danger), transparent 88%)" : "var(--bg-elev2)"
          : "transparent",
        transition: "background 0.08s",
      }}
    >
      <Icon size={12} style={{ flexShrink: 0, color: danger ? "var(--danger)" : "var(--fg-muted)" }} />
      <span style={{ color: danger ? "var(--danger)" : "var(--fg)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {sub && <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{sub}</span>}
    </div>
  );
}
