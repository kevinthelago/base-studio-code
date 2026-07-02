// The GitHub summary dashboard — the cross-repo analytics view (#1644).
//
// Presentation/composition only: the data + derivations live in `useGithubSummary`,
// the per-card UI in `summary/*`, and the React-free shaping in `lib/githubSummary.ts`.

import { useAppStore } from "@/store";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { useGithubSummary } from "./useGithubSummary";
import { ActivityHeatmap } from "./summary/ActivityHeatmap";
import { LanguageMix } from "./summary/LanguageMix";
import { ContributorsCard } from "./summary/ContributorsCard";
import { CrossRepoActivity } from "./summary/CrossRepoActivity";
import { OpenPRsAllRepos } from "./summary/OpenPRsCard";
import { ReposGrid } from "./summary/ReposGrid";
import { CIHealthCard } from "./summary/CIHealthCard";

// Re-export the shared page-mode strip from its previous home so existing
// `@/features/github/GitHubSummary` importers keep working.
export { GitHubPageModeStrip } from "./summary/GitHubPageModeStrip";

export function GitHubSummary() {
  const setGithubPageMode = useAppStore(s => s.setGithubPageMode);
  const {
    loading, githubRepos,
    heatmap, totalMerged, crossRepoEvts, openPRs,
    langTotals, langRepoCount, contributors, ciMatrix, repoGridData,
    kpiOpenPRs, kpiContribs, kpiCIPassing,
  } = useGithubSummary();
  const { heatmapCells, rawCounts, rawDates, totalContribs } = heatmap;

  return (
    <Box as="section" pad={[20, 24]} bg="var(--bg-canvas)" style={{ flex: 1, overflow: "auto", minWidth: 0}}>
      <Box style={{ maxWidth: 1280, margin: "0 auto" }}>
        <Row align="start" gap={14} style={{ marginBottom: 14 }}>
          <Box style={{ flex: 1 }}>
            <Text as="h2" mono size={20} weight={600} style={{ margin: 0 }}>Across all repositories</Text>
            <Text as="div" tone="muted" size="md" style={{ marginTop: 4 }}>
              {githubRepos.length} repo{githubRepos.length !== 1 ? "s" : ""} · 28-week view
            </Text>
          </Box>
          <Button onClick={() => setGithubPageMode("repos")}>browse repositories →</Button>
        </Row>

        <Grid cols={6} gap={8} style={{ marginBottom: 14 }}>
          {([
            ["repositories", String(githubRepos.length),               "all connected",                 "fg"     ],
            ["open PRs",     loading ? "…" : String(kpiOpenPRs),       `${openPRs.filter(p => !p.draft).length} ready to review`, "accent"],
            ["contributions · 28w", loading ? "…" : String(totalContribs), "commits · PRs · issues",      "success"],
            ["CI passing",   loading ? "…" : kpiCIPassing != null ? `${kpiCIPassing}%` : "—", "latest run per repo", "info"],
            ["contributors", loading ? "…" : String(kpiContribs),      "all repos",                     "muted"  ],
            ["merged PRs",       loading ? "…" : String(totalMerged),   "last ~90 days via events",      "muted"  ],
          ] as const).map(([k, v, sub, tone]) => (
            <Card key={k} style={{ padding: "10px 12px" }}>
              <SectionLabel>{k}</SectionLabel>
              <Box className="mono" style={{
                fontSize: 18, fontWeight: 600, marginTop: 2,
                color: tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : tone === "info" ? "var(--info)" : "var(--fg)",
              }}>{v}</Box>
              <Box style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</Box>
            </Card>
          ))}
        </Grid>

        <Grid cols="1.7fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ReposGrid repos={repoGridData} loading={loading} />
            <CrossRepoActivity events={crossRepoEvts} loading={loading} />
            <OpenPRsAllRepos prs={openPRs} loading={loading} />
          </Stack>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ActivityHeatmap cells={heatmapCells} rawCounts={rawCounts} rawDates={rawDates} totalContribs={totalContribs} totalMerged={totalMerged} loading={loading} />
            <CIHealthCard matrix={ciMatrix} loading={loading} />
            <ContributorsCard contributors={contributors} loading={loading} />
            <LanguageMix langTotals={langTotals} repoCount={langRepoCount} totalRepos={githubRepos.length} loading={loading} />
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}
