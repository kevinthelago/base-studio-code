import { useMemo } from "react";
import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  countOpenIssues,
  countMilestonesDueSoon,
  countLinkedRepos,
  avgWeeklyClosed,
} from "./projectsSummaryDerive";
import { IterationBurnDown } from "./IterationBurnDown";
import { CrossProjectActivity } from "./CrossProjectActivity";
import { useProjectsSummaryData } from "./summary/useProjectsSummaryData";
import { AISummary } from "./summary/AISummary";
import { ProjectAllocation } from "./summary/ProjectAllocation";
import { VelocityCard } from "./summary/VelocityCard";
import { UpcomingMilestones } from "./summary/UpcomingMilestones";
import { RiskRegister } from "./summary/RiskRegister";
import { ProjectsGrid } from "./summary/ProjectsGrid";

// ── Main ──────────────────────────────────────────────────────────────────────

export function ProjectsSummary() {
  const { setProjectsPageMode, setWorkspace } = useAppStore();
  // Hosted in the GitHub screen (#421) — "browse projects" jumps to the Projects tab.
  const openProjects = () => { setWorkspace("projects"); setProjectsPageMode("projects"); };
  const { loading, projects, events, repoMilestones, repoIssues, burndown } = useProjectsSummaryData();

  const activeProjects = projects.filter(p => !p.closed);
  const draftingCount = activeProjects.filter(p => p.items.totalCount === 0).length;
  const activeCount = activeProjects.filter(p => p.items.totalCount > 0).length;
  const shippedCount = projects.filter(p => p.closed).length;

  const totalOpenIssues = useMemo(() => countOpenIssues(repoIssues), [repoIssues]);
  const totalMilestones = useMemo(() => countMilestonesDueSoon(repoMilestones), [repoMilestones]);
  const avgVelocity = useMemo(() => avgWeeklyClosed(repoIssues), [repoIssues]);

  return (
    <Box as="section" pad={[20, 24]} bg="var(--bg-canvas)" style={{ flex: 1, overflow: "auto", minWidth: 0}}>
      <Box style={{ maxWidth: 1280, margin: "0 auto" }}>
        <Row align="start" gap={14} style={{ marginBottom: 14 }}>
          <Box style={{ flex: 1 }}>
            <Text as="h2" mono size={20} weight={600} style={{ margin: 0 }}>Portfolio</Text>
            <Text as="div" tone="muted" size={12} style={{ marginTop: 4 }}>
              {loading ? "loading…" : `${activeCount} active · ${draftingCount} drafting · ${shippedCount} shipped`}
            </Text>
          </Box>
          <Button onClick={openProjects}>browse projects →</Button>
        </Row>

        <Box style={{ marginBottom: 14 }}>
          <AISummary />
        </Box>

        <Grid cols={6} gap={8} style={{ marginBottom: 14 }}>
          {([
            ["projects",    loading ? "…" : String(projects.length),    `${activeCount} active · ${draftingCount} drafting`,  "fg"    ],
            ["open issues", loading ? "…" : String(totalOpenIssues),    "across project repos",              "accent" ],
            ["active",      loading ? "…" : String(activeCount),        "in-progress projects",              "info"   ],
            ["velocity",    loading ? "…" : `${avgVelocity}/wk`,        "avg issues closed",                 "muted"  ],
            ["milestones",  loading ? "…" : String(totalMilestones),    "due in next 2 weeks",               "info"   ],
            ["repos",       loading ? "…" : String(countLinkedRepos(projects)), "linked across projects", "muted"],
          ] as const).map(([k, v, sub, tone]) => (
            <Card key={k} style={{ padding: "10px 12px" }}>
              <Box className="mono-label">{k}</Box>
              <Box className="mono" style={{
                fontSize: 18, fontWeight: 600, marginTop: 2,
                color: tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : "var(--fg)",
              }}>{v}</Box>
              <Text as="div" size={10} tone="muted" style={{ marginTop: 1 }}>{sub}</Text>
            </Card>
          ))}
        </Grid>

        <Grid cols="1.6fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ProjectsGrid projects={projects} repoIssues={repoIssues} loading={loading} />
            <IterationBurnDown data={burndown} loading={loading} />
            <UpcomingMilestones repoMilestones={repoMilestones} loading={loading} />
            <CrossProjectActivity events={events} projects={projects} loading={loading} />
          </Stack>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ProjectAllocation projects={projects} />
            <VelocityCard repoIssues={repoIssues} loading={loading} />
            <RiskRegister />
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}
