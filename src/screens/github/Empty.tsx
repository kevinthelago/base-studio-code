export function GitHubEmpty() {
  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)",
    }}>
      <div style={{
        width: 480, padding: "36px 36px 32px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border-soft)",
        borderRadius: 12,
        textAlign: "center",
      }}>
        <div style={{
          width: 54, height: 54, margin: "0 auto 18px",
          borderRadius: 14,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--mono)", fontSize: 24, color: "var(--fg)",
        }}>⎇</div>

        <h2 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>
          Connect your GitHub account
        </h2>
        <p style={{ margin: "0 0 24px", color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
          Browse repositories, branches, pull requests, and recent activity right inside
          base-studio. We'll only read what you grant access to.
        </p>

        <button className="btn primary" style={{
          height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600,
          width: "100%", justifyContent: "center", gap: 10,
        }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 15 }}>⎇</span>
          Connect with GitHub
        </button>

        <div style={{
          margin: "18px 0", display: "flex", alignItems: "center", gap: 10,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        }}>
          <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
          <span>or</span>
          <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
        </div>

        <button className="btn" style={{ width: "100%", justifyContent: "center", height: 34 }}>
          Paste a personal access token
        </button>

        <div style={{
          marginTop: 22, padding: "12px 14px",
          borderRadius: 6, background: "var(--bg-elev)",
          border: "1px solid var(--border-soft)",
          textAlign: "left",
        }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6,
          }}>
            Scopes requested
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="tag">repo</span>
            <span className="tag">read:org</span>
            <span className="tag">read:user</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Token stored in your OS keyring. Revoke anytime from Settings.
          </div>
        </div>
      </div>
    </div>
  );
}
