import { type ViewKey, VIEW_DEFS } from "./ViewTabs";

export type ModelId = "haiku-4.5" | "sonnet-4.5" | "opus-4.5";

const MODELS: Array<{ id: ModelId; tone: string; price: string }> = [
  { id: "haiku-4.5",  tone: "fast",     price: "$ ·"    },
  { id: "sonnet-4.5", tone: "balanced", price: "$$ ··"  },
  { id: "opus-4.5",   tone: "deep",     price: "$$$ ···" },
];

interface HamburgerMenuProps {
  agent: string;
  repo?: string;
  branch?: string;
  model: ModelId;
  active: ViewKey;
  available: ViewKey[];
  onClose?: () => void;
}

export function HamburgerMenu({
  agent, repo, branch, model, active, available,
}: HamburgerMenuProps) {
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
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            <span style={{ color: "var(--info)" }}>⎇ {branch}</span>
            <span style={{ color: "var(--fg-dim)" }}> · </span>
            {repo}
          </div>
        )}
      </div>

      {/* Model */}
      <MenuSection label="model">
        {MODELS.map((m) => {
          const on = m.id === model;
          return (
            <MenuRow key={m.id} on={on}>
              <span style={{ color: on ? "var(--accent)" : "var(--fg-dim)", width: 10 }}>{on ? "●" : "○"}</span>
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{m.id}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5, marginRight: 6 }}>{m.tone}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{m.price}</span>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Views */}
      <MenuSection label="view">
        {available.map((k) => {
          const v = VIEW_DEFS[k];
          const on = k === active;
          return (
            <MenuRow key={k} on={on}>
              <span style={{ color: on ? "var(--accent)" : "var(--fg-muted)", width: 12, textAlign: "center" }}>{v.icon}</span>
              <span style={{ color: on ? "var(--accent)" : "var(--fg)", flex: 1 }}>{v.label}</span>
              {on && <span style={{ color: "var(--accent)", fontSize: 9.5, marginRight: 6 }}>current</span>}
              <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{v.hotkey}</span>
            </MenuRow>
          );
        })}
      </MenuSection>

      {/* Pane actions */}
      <MenuSection label="pane" last>
        <ActionRow icon="↻" label="rescan repo"    sub="re-detect HEAD" />
        <ActionRow icon="✦" label="pin knowledge…" sub="surface a block in context" />
        <ActionRow icon="⌖" label="set cwd…"       sub="change working dir" />
        <ActionRow icon="⊘" label="unbind repo"    sub="drop git context" danger />
        <ActionRow icon="✕" label="close pane"     sub="" danger />
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

function MenuRow({ on, children }: { on?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
      borderRadius: 5,
      background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
      cursor: "pointer",
    }}>{children}</div>
  );
}

function ActionRow({ icon, label, sub, danger }: { icon: string; label: string; sub: string; danger?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
      borderRadius: 5, cursor: "pointer",
    }}>
      <span style={{ width: 12, color: danger ? "var(--danger)" : "var(--fg-muted)" }}>{icon}</span>
      <span style={{ color: danger ? "var(--danger)" : "var(--fg)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {sub && <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{sub}</span>}
    </div>
  );
}
