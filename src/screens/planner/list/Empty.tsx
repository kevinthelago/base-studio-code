import { useAppStore } from "../../../store";

/**
 * GitHub-not-connected state for the Projects page — the leaner of the two
 * "connect" screens. Projects is the planning + fleet surface, so the copy is
 * about turning a pitch into an executable plan and launching agents; the full
 * "what you get" showcase lives on the GitHub page (see github/Empty.tsx). The
 * two designs were swapped in #776 so each lives where its content applies.
 */
export function ProjectsEmpty() {
  const setScreen = useAppStore((s) => s.setScreen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  return (
    <section style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)", padding: "40px 32px", overflow: "auto",
    }}>
      <div style={{
        width: 460, padding: "36px 36px 32px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border-soft)",
        borderRadius: 12,
        boxShadow: "0 18px 50px rgba(0,0,0,0.4)",
        textAlign: "center",
      }}>
        <div style={{
          width: 54, height: 54, margin: "0 auto 18px",
          borderRadius: 14,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--mono)", fontSize: 24, color: "var(--accent)",
        }}>🔒</div>

        <h2 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>
          Projects need GitHub
        </h2>
        <p style={{ margin: "0 0 24px", color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
          Planning with Claude turns a pitch into a complete, executable plan — features,
          milestones, granular issues, and a parallel agent fleet. Connect GitHub to publish
          that plan as a real Project board and run the fleet against your repos.
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
          textAlign: "left",
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
    </section>
  );
}
