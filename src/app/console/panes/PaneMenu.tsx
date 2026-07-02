import { useState } from "react";
import { Maximize2, Minimize2, Power, PowerOff, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type ViewKey, VIEW_DEFS } from "./viewDefs";
import { type ModelId, MODELS } from "@/app/console/lib/models";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";

// Re-exported so existing `import { type ModelId } from "./PaneMenu"` call sites keep working
// now that the catalog lives in the shared module (#…).
export type { ModelId };

// LLM-provider → its themed hue + the harness it runs under. Moved here from the header pill
// (#1319): the compact header trigger is tinted by session STATUS, so the provider identity now
// surfaces inside the menu. Absent / "claude" ⇒ Claude Code (anthropic); else the bsc-agent shell.
const PROV_COLOR: Record<string, string> = {
  claude: "var(--prov-anthropic)", anthropic: "var(--prov-anthropic)",
  openai: "var(--prov-openai)", codex: "var(--prov-openai)",
  gemini: "var(--prov-google)", google: "var(--prov-google)",
  local: "var(--prov-local)", ollama: "var(--prov-local)",
};
const harnessOf = (provider?: string) =>
  !provider || provider === "claude" || provider === "anthropic" ? "Claude Code" : "bsc-agent";

interface PaneMenuProps {
  agent: string;
  /** LLM provider id — drives the harness label + provider-hue dot in the menu header (#1319). */
  provider?: string;
  /** A session is live in this pane (`claudeActive`) — the menu header shows running vs idle. */
  running?: boolean;
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
  /** Force a TUI repaint of this pane via a resize nudge (#1221) — un-jumbles the Claude CLI. */
  onRedraw?: () => void;
  /** Open the directory picker to change this pane's working dir (moved here from the header). */
  onPickDirectory?: () => void;
  onClose?: () => void;
  onRename?: () => void;
  onViewChange?: (view: ViewKey) => void;
  /** Set this pane's model. Applies to `claude --model` on the pane's next launch. */
  onModel?: (model: ModelId) => void;
}

export function PaneMenu({
  agent, provider, running, model, runningModel, active, available, maxHeight, fullscreen, disabled,
  onToggleFullscreen, onToggleDisable, onRedraw, onClose, onRename, onViewChange, onModel,
}: PaneMenuProps) {
  const provColor = PROV_COLOR[provider ?? "claude"] ?? "var(--prov-local)";
  const harness = harnessOf(provider);
  // The highlighted row reflects what's ACTUALLY running when known (#1181), else the
  // configured model. Selecting a different row still sets the model for the next launch.
  const selected = runningModel ?? model;
  return (
    <Box className="mono" style={{
      width: 268,
      maxHeight,
      background: "var(--bg-panel)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02)",
      // Scroll vertically (capped by maxHeight) but keep rounded corners; the menu's
      // own drop shadow is unaffected since overflow only clips descendants.
      overflowX: "hidden", overflowY: "auto",
      fontSize: 11,
    }}>
      {/* Header */}
      <Box pad={[10, 12]} bg="var(--bg-elev)" style={{ borderBottom: "1px solid var(--border-soft)",
      }}>
        <Row align="baseline" gap={8}>
          <Text size={12} weight={600} style={{ color: "var(--fg)" }}>{agent}</Text>
          <Box as="span" style={{ flex: 1 }} />
          <Text
            tone="dim" size={10} style={{ cursor: "pointer" }}
            onClick={onRename}
          >rename</Text>
        </Row>
        {/* Harness + provider (#1319) — moved here from the header pill. The provider-hue dot + the
            harness label that once sat in the header now identify the runtime inside the menu. */}
        <Row gap={6} style={{ marginTop: 6 }}>
          <Box as="span" bg={provColor} style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0}} />
          <Text size={10} tone="muted">{harness}</Text>
          <Box as="span" style={{ flex: 1 }} />
          <Text size={9.5} style={{ color: running ? "var(--accent)" : "var(--fg-dim)" }}>
            {running ? "running" : "idle"}
          </Text>
        </Row>
      </Box>

      {/* Model */}
      <MenuSection label="model">
        {MODELS.map((m) => {
          const on = m.id === selected;
          const isRunning = runningModel != null && m.id === runningModel;
          return (
            <MenuRow key={m.id} on={on} onClick={onModel ? () => { onModel(m.id); onClose?.(); } : undefined}>
              <Box as="span" bg={on ? "var(--accent)" : "var(--border)"} style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
              }} />
              <Text style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{m.id}</Text>
              {isRunning && <Text tone="accent" size={9} style={{ marginRight: 6 }}>running</Text>}
              <Text tone="dim" size={9.5} style={{ marginRight: 6 }}>{m.tone}</Text>
              <Text tone="dim" size={9.5} style={{ fontFamily: "var(--sans)" }}>{m.price}</Text>
            </MenuRow>
          );
        })}
        <Text as="div" tone="dim" size={9} style={{ padding: "4px 8px 0" }}>
          applies on the pane's next launch (disable → enable to apply now)
        </Text>
      </MenuSection>

      {/* Views */}
      <MenuSection label="view">
        {available.map((k) => {
          const { Icon, label, hotkey } = VIEW_DEFS[k];
          const on = k === active;
          return (
            <MenuRow key={k} on={on} onClick={() => { onViewChange?.(k); onClose?.(); }}>
              <Icon size={12} style={{ flexShrink: 0, color: on ? "var(--accent)" : "var(--fg-muted)" }} />
              <Text style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{label}</Text>
              {on && <Text tone="accent" size={9.5} style={{ marginRight: 6 }}>current</Text>}
              <Text tone="dim" size={9.5}>{hotkey}</Text>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Pane actions */}
      <MenuSection label="pane" last>
        <ActionRow
          Icon={RefreshCw}
          label="redraw / fix display"
          sub="repaint a jumbled terminal"
          onClick={() => { onRedraw?.(); onClose?.(); }}
        />
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
    </Box>
  );
}

function MenuSection({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <Box pad={[6, 6]} style={{ borderBottom: last ? "0" : "1px solid var(--border-soft)" }}>
      <Text as="div" tone="dim" size={9.5} style={{
        padding: "4px 8px 6px",
        textTransform: "uppercase", letterSpacing: ".08em",
      }}>{label}</Text>
      <Stack gap={1}>{children}</Stack>
    </Box>
  );
}

function MenuRow({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const bg = on
    ? "color-mix(in oklch, var(--accent), transparent 90%)"
    : hovered ? "var(--bg-elev2)" : "transparent";
  return (
    <Row
      gap={6}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "6px 8px",
        borderRadius: 5, background: bg, cursor: "pointer",
        transition: "background 0.08s",
      }}
    >{children}</Row>
  );
}

function ActionRow({ Icon, label, sub, danger, onClick }: {
  Icon: LucideIcon; label: string; sub: string; danger?: boolean; onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Row
      gap={8}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "6px 8px",
        borderRadius: 5, cursor: "pointer",
        background: hovered
          ? danger ? "color-mix(in oklch, var(--danger), transparent 88%)" : "var(--bg-elev2)"
          : "transparent",
        transition: "background 0.08s",
      }}
    >
      <Icon size={12} style={{ flexShrink: 0, color: danger ? "var(--danger)" : "var(--fg-muted)" }} />
      <Text style={{ color: danger ? "var(--danger)" : "var(--fg)" }}>{label}</Text>
      <Box as="span" style={{ flex: 1 }} />
      {sub && <Text size={9.5} tone="dim">{sub}</Text>}
    </Row>
  );
}
