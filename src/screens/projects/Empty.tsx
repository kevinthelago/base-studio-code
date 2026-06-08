import { useAppStore } from "../../store";

export function ProjectsEmpty() {
  const setScreen = useAppStore((s) => s.setScreen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  return (
    <section style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)", padding: "40px 32px", overflow: "auto",
    }}>
      <div style={{
        maxWidth: 880, width: "100%",
        display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 32, alignItems: "center",
      }}>
        {/* Lock card */}
        <div style={{
          padding: "34px 32px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border-soft)",
          borderRadius: 14,
          boxShadow: "0 18px 50px rgba(0,0,0,0.4)",
        }}>
          <div style={{
            width: 54, height: 54, borderRadius: 14,
            background: "var(--bg-elev)", border: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--mono)", fontSize: 24, color: "var(--accent)", marginBottom: 18,
          }}>🔒</div>
          <h2 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>
            Projects need GitHub
          </h2>
          <p style={{ margin: "0 0 22px", color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
            Boards, issues, and milestones in base-studio mirror real GitHub Projects — no parallel
            database, no drift, no re-keying. Connect once and your Kanban becomes the same Kanban
            your team sees on github.com.
          </p>

          <button
            className="btn primary"
            // Land on the GitHub settings tab, not just the Settings screen (mirrors
            // the GitHub screen's own empty state).
            onClick={() => { setSettingsSection("github"); setScreen("settings"); }}
            style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center", gap: 10 }}
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: 15 }}>⎇</span>
            Connect with GitHub
          </button>

          <div style={{
            display: "flex", alignItems: "center", gap: 10, margin: "16px 0",
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          }}>
            <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
            <span>or</span>
            <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
          </div>

          <button className="btn ghost" style={{ width: "100%", justifyContent: "center", height: 34, fontSize: 12 }}>
            Open a one-off AI scoping session (won't be saved)
          </button>

          <div style={{
            marginTop: 20, padding: "12px 14px",
            borderRadius: 6, background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6,
            }}>Scopes requested</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["repo", "project", "issues", "read:org"].map(s => (
                <span key={s} className="tag">{s}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Feature list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
            textTransform: "uppercase", letterSpacing: ".08em",
          }}>what you get</div>
          {[
            ["Kanban board",        "Real-time mirror of a GitHub Project. Drag to move; columns map to GH status fields."],
            ["AI issue breakdowns", "Open any issue, ask Claude to break it into subtasks. Optionally creates them as linked issues."],
            ["Paired scoping",      "Start a new project from a one-line pitch; Claude asks questions until it can create issues + a milestone."],
            ["Roadmap view",        "Milestones laid out across time, with PR / commit activity inline."],
            ["Two-way sync",        "Edits here land on github.com immediately. Webhook events update the board live."],
          ].map(([h, b], i) => (
            <div key={h} style={{
              padding: "12px 14px",
              background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
              display: "grid", gridTemplateColumns: "22px 1fr", gap: 10,
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: 5,
                background: "var(--bg-elev2)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11,
                marginTop: 1,
              }}>{i + 1}</span>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{h}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.55, marginTop: 2 }}>{b}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
