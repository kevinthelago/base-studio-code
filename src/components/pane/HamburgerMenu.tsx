import { RefreshCw, Pin, FolderInput, Unlink2, X, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type ViewKey, VIEW_DEFS } from "./ViewTabs";
import { listProviders } from "../../lib/consoleProviders";

export type ModelId = "haiku-4.5" | "sonnet-4.5" | "opus-4.5";

const MODELS: Array<{ id: ModelId; tone: string; price: string }> = [
  { id: "haiku-4.5",  tone: "fast",     price: "$"   },
  { id: "sonnet-4.5", tone: "balanced", price: "$$"  },
  { id: "opus-4.5",   tone: "deep",     price: "$$$" },
];

interface HamburgerMenuProps {
  agent: string;
  repo?: string;
  branch?: string;
  model: ModelId;
  active: ViewKey;
  available: ViewKey[];
  /** Currently selected provider id for this pane. Absent ⇒ "claude". */
  providerId?: string;
  /** Called when the user picks a different provider. */
  onProviderChange?: (id: string) => void;
  onClose?: () => void;
}

export function HamburgerMenu({
  agent, repo, branch, model, active, available, providerId = "claude", onProviderChange,
}: HamburgerMenuProps) {
  const providers = listProviders();
  return (
    <div style={{
      position: "absolute", top: 38, right: 6, zIndex: 20,
      width: 268,
      background: "var(--bg-panel)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02)",
      overflow: "hidden",
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
          <span style={{ color: "var(--fg-dim)", fontSize: 10, cursor: "pointer" }}>rename</span>
        </div>
        {repo && (
          <div style={{
            fontSize: 10, color: "var(--fg-muted)", marginTop: 3,
            display: "flex", alignItems: "center", gap: 4,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            <GitBranch size={9} style={{ color: "var(--info)", flexShrink: 0 }} />
            <span style={{ color: "var(--info)" }}>{branch}</span>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{repo}</span>
          </div>
        )}
      </div>

      {/* Model */}
      <MenuSection label="model">
        {MODELS.map((m) => {
          const on = m.id === model;
          return (
            <MenuRow key={m.id} on={on}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: on ? "var(--accent)" : "var(--border)",
              }} />
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{m.id}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5, marginRight: 6 }}>{m.tone}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5, fontFamily: "var(--sans)" }}>{m.price}</span>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Provider */}
      <MenuSection label="provider">
        {providers.map((p) => {
          const on = p.id === providerId;
          return (
            <MenuRow key={p.id} on={on} onClick={() => onProviderChange?.(p.id)}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: on ? "var(--accent)" : "var(--border)",
              }} />
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{p.displayName}</span>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Views */}
      <MenuSection label="view">
        {available.map((k) => {
          const { Icon, label, hotkey } = VIEW_DEFS[k];
          const on = k === active;
          return (
            <MenuRow key={k} on={on}>
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
        <ActionRow Icon={RefreshCw} label="rescan repo"    sub="re-detect HEAD" />
        <ActionRow Icon={Pin}       label="pin knowledge…" sub="surface a block in context" />
        <ActionRow Icon={FolderInput} label="set cwd…"     sub="change working dir" />
        <ActionRow Icon={Unlink2}   label="unbind repo"    sub="drop git context" danger />
        <ActionRow Icon={X}         label="close pane"     sub="" danger />
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
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
        borderRadius: 5,
        background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
        cursor: "pointer",
      }}
    >{children}</div>
  );
}

function ActionRow({ Icon, label, sub, danger }: { Icon: LucideIcon; label: string; sub: string; danger?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
      borderRadius: 5, cursor: "pointer",
    }}>
      <Icon size={12} style={{ flexShrink: 0, color: danger ? "var(--danger)" : "var(--fg-muted)" }} />
      <span style={{ color: danger ? "var(--danger)" : "var(--fg)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {sub && <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{sub}</span>}
    </div>
  );
}
