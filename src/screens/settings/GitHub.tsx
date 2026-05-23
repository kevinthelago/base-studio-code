import { SETTINGS_REPOS } from "../../data/mock";

export function GitHubSettings() {
  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>GitHub</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Connect your GitHub account to browse repos, branches, and pull requests.
      </p>

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{
          width: 44, height: 44, borderRadius: "50%",
          background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--mono)", fontSize: 18, color: "var(--fg)",
        }}>L</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b style={{ fontFamily: "var(--mono)", fontSize: 13 }}>lina-engelbrecht</b>
            <span className="tag green">● connected</span>
            <span className="tag">scopes: repo · read:org · read:user</span>
          </div>
          <div className="hint" style={{ marginTop: 3 }}>token rotated 14 days ago · expires in 76 days</div>
        </div>
        <button className="btn">Re-authenticate</button>
        <button className="btn danger">Disconnect</button>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Repositories</h3>
          <span className="hint">3 of 5 selected — these show up in the GitHub tab.</span>
          <div style={{ flex: 1 }} />
          <input className="input" placeholder="filter…" style={{ width: 180 }} />
        </div>

        <div style={{
          display: "flex", flexDirection: "column", gap: 1,
          borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-soft)",
        }}>
          {SETTINGS_REPOS.map((r, i) => (
            <div key={r.name} style={{
              display: "grid", gridTemplateColumns: "24px 1.4fr 1fr 1.6fr 90px",
              alignItems: "center", gap: 12, padding: "11px 14px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              fontSize: 11.5,
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: 4,
                background: r.on ? "var(--accent)" : "transparent",
                border: "1px solid " + (r.on ? "var(--accent)" : "var(--border)"),
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#1a120a", fontSize: 11, fontWeight: 700,
              }}>{r.on ? "✓" : ""}</div>
              <div>
                <div style={{ fontFamily: "var(--mono)" }}>{r.name}</div>
                <div className="hint">{r.desc}</div>
              </div>
              <div>
                <span className="tag">{r.priv ? "private" : "public"}</span>
                <span style={{ marginLeft: 6, fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>{r.branch}</span>
              </div>
              <div style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)", fontSize: 10.5 }}>{r.hooks}</div>
              <div style={{ textAlign: "right" }}>
                <button className="btn ghost" style={{ height: 24, padding: "0 8px", fontSize: 10.5 }}>configure</button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          <div className="hint">
            Webhook deliveries land on <span className="kbd">/gh/webhook</span>.
          </div>
          <button className="btn">+ Install on more repos</button>
        </div>
      </div>
    </div>
  );
}
