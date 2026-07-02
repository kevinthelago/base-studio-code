import { useMemo } from "react";
import { useAppStore } from "@/store";
import { timeAgo } from "@/shared/lib/core/format";
import { Chip } from "@/shared/ui/data/Chip";
import { Card } from "@/shared/ui/data/Card";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { GhIssueItem as GhIssue } from "@/shared/lib/github/types";
import { Spark } from "@/shared/ui/charts";
import { computeProjectStats, type GhProject } from "@/features/planner/list/projectsSummaryDerive";

// ── Projects grid ─────────────────────────────────────────────────────────────

export function ProjectsGrid({ projects, repoIssues, loading }: {
  projects: GhProject[];
  repoIssues: Record<string, GhIssue[]>;
  loading: boolean;
}) {
  const { setProjectsPageMode, setWorkspace, setActiveProjectMeta, openGithubBoard } = useAppStore();
  // This portfolio lives in the GitHub screen (#421); "view list" jumps to the
  // Projects tab for planning, while opening a card shows that project's board
  // right here on the GitHub page (#498).
  const openProjects = () => { setWorkspace("projects"); setProjectsPageMode("projects"); };
  const openBoard = (p: GhProject) => {
    const repos = p.repositories?.nodes?.map(r => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    openGithubBoard("board");
  };

  const projectsWithStats = useMemo(
    () => computeProjectStats(projects, repoIssues),
    [projects, repoIssues],
  );

  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row gap={10} align="baseline" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Projects</h3>
        <Box as="span" className="hint">{loading ? "loading…" : `${projects.length} project${projects.length !== 1 ? "s" : ""} · click to open the board`}</Box>
        <Spacer />
        <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}
          onClick={openProjects}>view list →</Button>
      </Row>
      {projects.length === 0 && !loading && (
        <Text as="div" mono size={11} tone="dim" style={{ padding: "8px 0" }}>No projects found. Create one on GitHub.</Text>
      )}
      <Grid cols="repeat(2, minmax(0, 1fr))" gap={8}>
        {projectsWithStats.map(({ p, c, status, spark, repo }) => (
          <Box key={p.id} onClick={() => openBoard(p)} pad={[12, 14]} bg="var(--bg-elev)" border="soft" radius={6} style={{
            cursor: "pointer", minWidth: 0, overflow: "hidden",
          }}>
            <Row gap={8} align="baseline" style={{ marginBottom: 4 }}>
              <ColorSwatch color={c} size={8} />
              <Box as="span" className="mono" style={{ fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{p.title}</Box>
              <Chip tone={status === "active" ? "success" : status === "shipped" ? "neutral" : "accent"} style={{ fontSize: 9 }}>{status}</Chip>
            </Row>
            <Text as="div" mono size={10} tone="dim" style={{ marginBottom: 8 }}>
              {repo}
            </Text>
            <Row gap={12} className="mono" style={{ fontSize: 10, color: "var(--fg-muted)" }}>
              <Box as="span"><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</Box>
              <Text mono size={9.5} tone="dim">{timeAgo(p.updatedAt)}</Text>
              <Spacer />
              {spark.some(v => v > 0) && <Spark data={spark} color={c} w={80} h={18} fill={false} dot={false} />}
            </Row>
          </Box>
        ))}
      </Grid>
    </Card>
  );
}
