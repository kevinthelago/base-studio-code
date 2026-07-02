import { useAppStore } from "@/store";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Chip } from "@/shared/ui/data/Chip";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
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
    <Box as="section" pad={[40, 32]} bg="var(--bg-canvas)" style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto",
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
              <Text as="span" mono size={15}>⎇</Text>
              Connect with GitHub
            </Button>
          }
          extra={
            <Box pad={[12, 14]} bg="var(--bg-elev)" border="soft" radius={6} style={{
              marginTop: 20,
            }}>
              <SectionLabel style={{ marginBottom: 6 }}>Scopes requested</SectionLabel>
              <Row gap={6} wrap align="stretch">
                {["repo", "project", "read:org", "read:user"].map(s => (
                  <Chip key={s}>{s}</Chip>
                ))}
              </Row>
              <Box style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                Create a token at{" "}
                <Text as="span" mono size={11} tone="accent">
                  github.com/settings/tokens
                </Text>
              </Box>
            </Box>
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
              <Box as="span" className="mono" bg="var(--bg-elev2)" radius={5} style={{
                width: 20, height: 20,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)", fontWeight: 700, fontSize: 11,
                marginTop: 1,
              }}>{i + 1}</Box>
              <Box>
                <Box className="mono-value">{h}</Box>
                <Box style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.55, marginTop: 2 }}>{b}</Box>
              </Box>
            </Grid>
          ))}
        </Stack>
      </Grid>
    </Box>
  );
}
