import { useAppStore } from "@/store";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { countLinkedRepos } from "./projectsSummaryDerive";
import { useProjectsSummaryData } from "./summary/useProjectsSummaryData";
import { AISummary } from "./summary/AISummary";
import { ProjectAllocation } from "./summary/ProjectAllocation";
import { RiskRegister } from "./summary/RiskRegister";
import { ProjectsGrid } from "./summary/ProjectsGrid";

// ── Main ──────────────────────────────────────────────────────────────────────

// The Portfolio shows just the project data now (#3675) — the per-repo issue/milestone/velocity/
// burndown cards fed a project-detail flow that no longer exists, at the cost of 4+ slow REST calls
// per mount. Everything below derives from the single Projects-v2 GraphQL query.
export function ProjectsSummary() {
  const { navigate } = useAppStore();
  // Hosted in the GitHub screen (#421) — "browse projects" jumps to the Projects tab.
  const openProjects = () => navigate({ workspace: "projects", page: "projects" });
  const { loading, projects } = useProjectsSummaryData();

  const activeProjects = projects.filter(p => !p.closed);
  const draftingCount = activeProjects.filter(p => p.items.totalCount === 0).length;
  const activeCount = activeProjects.filter(p => p.items.totalCount > 0).length;
  const shippedCount = projects.filter(p => p.closed).length;

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

        <Grid cols={3} gap={8} style={{ marginBottom: 14 }}>
          {([
            ["projects", loading ? "…" : String(projects.length),           `${activeCount} active · ${draftingCount} drafting`, "fg"   ],
            ["active",   loading ? "…" : String(activeCount),                "in-progress projects",                              "info" ],
            ["repos",    loading ? "…" : String(countLinkedRepos(projects)), "linked across projects",                            "muted"],
          ] as const).map(([k, v, sub, tone]) => (
            <StatTile
              key={k}
              k={k}
              v={v}
              sub={sub}
              vStyle={tone === "info" ? { color: "var(--info)" } : undefined}
            />
          ))}
        </Grid>

        <Grid cols="1.6fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ProjectsGrid projects={projects} loading={loading} />
          </Stack>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <ProjectAllocation projects={projects} />
            <RiskRegister />
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}
