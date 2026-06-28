import { useAppStore } from "@/store";
import { EmptyState } from "@/shared/ui/EmptyState";
import { SectionLabel } from "@/shared/ui/SectionLabel";

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
      <EmptyState
        variant="card"
        icon="🔒"
        title="Projects need GitHub"
        description="Planning with Claude turns a pitch into a complete, executable plan — features, milestones, granular issues, and a parallel agent fleet. Connect GitHub to publish that plan as a real Project board and run the fleet against your repos."
        actions={
          <button
            className="btn primary"
            // Land on the GitHub settings tab, not just the Settings screen.
            onClick={() => { setSettingsSection("github"); setScreen("settings"); }}
            style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center", gap: 10 }}
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: 15 }}>⎇</span>
            Connect with GitHub
          </button>
        }
        extra={
          <div style={{
            marginTop: 20, padding: "12px 14px",
            borderRadius: 6, background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            textAlign: "left",
          }}>
            <SectionLabel style={{ marginBottom: 6 }}>Scopes requested</SectionLabel>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["repo", "project", "issues", "read:org"].map(s => (
                <span key={s} className="tag">{s}</span>
              ))}
            </div>
          </div>
        }
      />
    </section>
  );
}
