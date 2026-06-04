import { SHORTCUT_GROUPS } from "../../lib/shortcuts";

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 20, height: 22, padding: "0 7px",
      fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)",
      background: "var(--bg-elev2)", border: "1px solid var(--border)",
      borderRadius: 5, boxShadow: "0 1px 0 var(--border)",
    }}>{children}</kbd>
  );
}

export function KeyboardSettings() {
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Keyboard</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Every keyboard shortcut, grouped by what it affects. Rebinding is planned — for now
        this is the reference.
      </p>

      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
            <h3 style={{ margin: 0 }}>{group.title}</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {group.items.map((s, i) => (
              <div
                key={s.desc}
                style={{
                  display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "center",
                  padding: "9px 12px", borderRadius: 6,
                  background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: "var(--fg)" }}>{s.desc}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{s.scope}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {s.keys.map((k, ki) => (
                    <span key={ki} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {ki > 0 && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>+</span>}
                      <KeyCap>{k}</KeyCap>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
