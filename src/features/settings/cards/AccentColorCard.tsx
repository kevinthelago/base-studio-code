import { useAppStore } from "@/store";
import { ACCENT_PRESETS, accentVars } from "../lib/appearance";
import { Card } from "@/shared/ui/Card";

export function AccentColorCard() {
  const { accent, setAccent } = useAppStore();

  return (
    <Card title="Accent color" hint="the highlight color used across the app">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {ACCENT_PRESETS.map((p) => {
          const on = p.id === accent;
          const { accent: color } = accentVars(p.id);
          return (
            <button
              key={p.id}
              aria-label={p.label}
              aria-pressed={on}
              title={p.label}
              onClick={() => setAccent(p.id)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px 6px 8px", borderRadius: 99, cursor: "pointer",
                background: on ? "var(--bg-elev2)" : "var(--bg-elev)",
                border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
                fontFamily: "var(--mono)", fontSize: 11,
                color: on ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <span style={{
                width: 16, height: 16, borderRadius: "50%", background: color,
                boxShadow: on ? "0 0 0 2px var(--bg-elev2), 0 0 0 3px " + color : "none",
              }} />
              {p.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
