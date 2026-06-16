import { useAppStore } from "../../store";

/**
 * GitHub-not-connected state for the GitHub page — the richer of the two
 * "connect" screens. The GitHub page is the portfolio hub (it owns the project
 * boards, roadmap, issues, insights, and per-repo pulse since #498/#499), so it
 * carries the full "what you get" showcase. The Projects page uses the leaner
 * card (see projects/Empty.tsx); the two designs were swapped in #776 so each
 * lives where its content actually applies.
 */
export function GitHubEmpty() {
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
        {/* Connect card */}
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
          }}>⎇</div>
          <h2 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>
            GitHub not connected
          </h2>
          <p style={{ margin: "0 0 22px", color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
            The GitHub page mirrors github.com — every repository and Project, their boards,
            roadmaps, and activity, with no parallel database and no drift. Connect a token
            once and the whole portfolio is live, two-way, and in sync.
          </p>

          <button
            className="btn primary"
            // Land on the GitHub settings tab, not just the Settings screen.
            onClick={() => { setSettingsSection("github"); setScreen("settings"); }}
            style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center", gap: 10 }}
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: 15 }}>⎇</span>
            Connect with GitHub
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
              {["repo", "project", "read:org", "read:user"].map(s => (
                <span key={s} className="tag">{s}</span>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              Create a token at{" "}
              <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>
                github.com/settings/tokens
              </span>
            </div>
          </div>
        </div>

        {/* Feature list — the GitHub page's current surfaces (#498/#499). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
            textTransform: "uppercase", letterSpacing: ".08em",
          }}>what you get</div>
          {[
            ["Portfolio summary", "Every repo and GitHub Project in one view, with live analytics — open issues, PRs, CI, and contributor activity."],
            ["Project boards",    "Open any GitHub Project as a real-time Kanban mirror. Drag to move; columns map to GH status fields."],
            ["Repository pulse",  "Per-repo dashboard: progress, recent changes, CI status, contributors, and the branch graph."],
            ["Roadmap & issues",  "Milestones laid out across time with PR / commit activity inline; drill into issues and insights over the board."],
            ["Two-way sync",      "Edits here land on github.com immediately. Webhook events update every view live."],
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
