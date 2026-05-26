import { useAppStore } from "../../store";

export function GitHubEmpty() {
  const { setScreen, setSettingsSection } = useAppStore();

  function goToSettings() {
    setSettingsSection("github");
    setScreen("settings");
  }

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)",
    }}>
      <div style={{
        width: 440, padding: "36px 36px 32px",
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
          GitHub not connected
        </h2>
        <p style={{ margin: "0 0 24px", color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
          Connect a Personal Access Token in Settings to browse repositories,
          branches, pull requests, and activity.
        </p>

        <button
          className="btn primary"
          style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center" }}
          onClick={goToSettings}
        >
          Go to Settings → GitHub
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
            Scopes required
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="tag">repo</span>
            <span className="tag">read:org</span>
            <span className="tag">read:user</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Create a token at{" "}
            <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>
              github.com/settings/tokens
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
