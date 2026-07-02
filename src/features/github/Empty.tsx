import { useAppStore } from "@/store";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Chip } from "@/shared/ui/data/Chip";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Button } from "@/shared/ui/controls/Button";

/**
 * GitHub-not-connected state for the GitHub page — the richer of the two
 * "connect" screens. The GitHub page is the portfolio hub (it owns the project
 * boards, roadmap, issues, insights, and per-repo pulse since #498/#499), so it
 * carries the full "what you get" showcase. The Projects page uses the leaner
 * card (see planner/list/Empty.tsx); the two designs were swapped in #776 so each
 * lives where its content actually applies.
 */
export function GitHubEmpty() {
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  return (
    <section style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)", padding: "40px 32px", overflow: "auto",
    }}>
      <Grid cols="1.1fr 1fr" gap={32} align="center" style={{
        maxWidth: 880, width: "100%",
      }}>
        {/* Connect card — the shared EmptyState skeleton; width is grid-driven, not the fixed 460. */}
        <EmptyState
          variant="card"
          align="left"
          style={{ width: "auto", padding: "34px 32px" }}
          icon="⎇"
          title="GitHub not connected"
          description="The GitHub page mirrors github.com — every repository and Project, their boards, roadmaps, and activity, with no parallel database and no drift. Connect a token once and the whole portfolio is live, two-way, and in sync."
          actions={
            <Button
              variant="primary"
              // Land on the GitHub settings tab, not just the Settings screen.
              onClick={() => { setSettingsSection("github"); setWorkspace("settings"); }}
              style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center", gap: 10 }}
            >
              <span className="mono" style={{ fontSize: 15 }}>⎇</span>
              Connect with GitHub
            </Button>
          }
          extra={
            <div style={{
              marginTop: 20, padding: "12px 14px",
              borderRadius: 6, background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            }}>
              <SectionLabel style={{ marginBottom: 6 }}>Scopes requested</SectionLabel>
              <Row gap={6} wrap align="stretch">
                {["repo", "project", "read:org", "read:user"].map(s => (
                  <Chip key={s}>{s}</Chip>
                ))}
              </Row>
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                Create a token at{" "}
                <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
                  github.com/settings/tokens
                </span>
              </div>
            </div>
          }
        />

        {/* Feature list — the GitHub page's current surfaces (#498/#499). */}
        <Stack gap={14}>
          <SectionLabel style={{ letterSpacing: ".08em" }}>what you get</SectionLabel>
          {[
            ["Portfolio summary", "Every repo and GitHub Project in one view, with live analytics — open issues, PRs, CI, and contributor activity."],
            ["Project boards",    "Open any GitHub Project as a real-time Kanban mirror. Drag to move; columns map to GH status fields."],
            ["Repository pulse",  "Per-repo dashboard: progress, recent changes, CI status, contributors, and the branch graph."],
            ["Roadmap & issues",  "Milestones laid out across time with PR / commit activity inline; drill into issues and insights over the board."],
            ["Two-way sync",      "Edits here land on github.com immediately. Webhook events update every view live."],
          ].map(([h, b], i) => (
            <Grid key={h} cols="22px 1fr" gap={10} style={{
              padding: "12px 14px",
              background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
            }}>
              <span className="mono" style={{
                width: 20, height: 20, borderRadius: 5,
                background: "var(--bg-elev2)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)", fontWeight: 700, fontSize: 11,
                marginTop: 1,
              }}>{i + 1}</span>
              <div>
                <div className="mono-value">{h}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.55, marginTop: 2 }}>{b}</div>
              </div>
            </Grid>
          ))}
        </Stack>
      </Grid>
    </section>
  );
}
