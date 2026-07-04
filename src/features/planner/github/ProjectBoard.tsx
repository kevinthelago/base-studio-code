import { useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { reposFromItems } from "../list/projectScan";
import { GH_OPTION_COLORS } from "@/shared/lib/github/colors";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Skeleton, SkeletonText } from "@/shared/ui/feedback/Skeleton";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import type { GhLabel } from "@/shared/lib/github/types";
import { BOARD_QUERY } from "./projectBoard.query";
import type { GhUser, BoardIssue, BoardColumn } from "./projectBoard.types";
import { Column } from "./Column";
import { IssueDrawer } from "./IssueDrawer";

// ── Board ─────────────────────────────────────────────────────────────────────

/** A loading placeholder shaped like a board Column — a header + a few issue-card skeletons (#2248). */
function SkeletonColumn() {
  return (
    <Box style={{ flex: "0 0 280px", width: 280, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
      <Skeleton w="55%" h={12} style={{ marginBottom: 12 }} />
      <Stack gap={8}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Box key={i} style={{ background: "var(--bg-soft)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10 }}>
            <SkeletonText lines={2} lineH={9} />
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export function ProjectBoard() {
  const { projectsDrawerIssue, setProjectsDrawerIssue, setActiveProjectRepos } = useAppStore();
  const { project, data, loading, error } = useActiveProjectGithub<{ node: Record<string, unknown> }>(BOARD_QUERY);

  const { columns, byColumn, allItems, repos } = useMemo(() => {
    const node = data?.node as ProjectV2Node | undefined;
    if (!node) return { columns: [] as BoardColumn[], byColumn: {} as Record<string, BoardIssue[]>, allItems: [] as BoardIssue[], repos: [] as string[] };

    // Columns from the Status single-select field (fallback to a single catch-all).
    const cols: BoardColumn[] = parseProjectV2Fields(node).map(o => ({
      id: o.id,
      name: o.name,
      color: GH_OPTION_COLORS[o.color] ?? "var(--fg-dim)",
    }));
    if (cols.length === 0) cols.push({ id: "all", name: "All items", color: "var(--fg-dim)" });

    // Map items to BoardIssue, carrying the Status optionId so we can group after.
    const mapped = parseProjectV2Items<{
      number: number; title: string; body: string; state: string;
      labels: { nodes: GhLabel[] };
      assignees: { nodes: GhUser[] };
      comments: { totalCount: number };
      milestone?: { title: string } | null;
    }, { issue: BoardIssue; colId: string }>(node, (c, item) => ({
      issue: {
        id: item.id,
        number: c.number,
        title: c.title,
        body: c.body ?? "",
        labels: c.labels.nodes,
        assignees: c.assignees.nodes,
        comments: c.comments.totalCount,
        milestone: c.milestone?.title ?? null,
        state: c.state,
      },
      colId: statusFieldValue(item)?.optionId ?? (cols[0]?.id ?? "all"),
    }));

    const grouped: Record<string, BoardIssue[]> = {};
    cols.forEach(c => { grouped[c.id] = []; });
    const flat: BoardIssue[] = [];
    for (const { issue, colId } of mapped) {
      flat.push(issue);
      if (grouped[colId]) grouped[colId].push(issue);
      else grouped[cols[0]?.id ?? "all"] = [...(grouped[cols[0]?.id ?? "all"] ?? []), issue];
    }

    // Derive repos from the issues themselves — more reliable than the
    // project-level repositories field, which requires explicit linking in GitHub UI.
    return { columns: cols, byColumn: grouped, allItems: flat, repos: reposFromItems(node.items.nodes as Parameters<typeof reposFromItems>[0]) };
  }, [data]);

  // Sync the derived repos to the store (a side effect, so it can't live in the parse memo).
  useEffect(() => {
    if (repos.length > 0) setActiveProjectRepos(repos);
  }, [repos, setActiveProjectRepos]);

  const drawerOpen = projectsDrawerIssue !== null;
  const drawerIssue = drawerOpen ? allItems.find(i => i.number === projectsDrawerIssue) : undefined;

  return (
    <>
      <ProjectsHeader project={project} />
      <section style={{ flex: 1, padding: "14px 16px", overflow: "hidden", background: "var(--bg-canvas)", position: "relative" }}>
        <QueryBanner error={error} style={{ margin: 8 }} />

        {/* Board columns — always present; skeleton columns while loading, a real empty state when the
            board has no items, else the live columns (#2248). No page-wide blank overlay. */}
        <Row gap={10} align="stretch" style={{
          height: "100%", overflow: "auto",
          opacity: drawerOpen ? 0.35 : 1,
          pointerEvents: drawerOpen ? "none" : undefined,
          transition: "opacity 0.15s",
        }}>
          {loading && allItems.length === 0
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonColumn key={i} />)
            : allItems.length === 0
              ? (
                <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <EmptyState iconVariant="dashed" icon="▦" title="No board items yet"
                    description="Publish this project's plan to GitHub to populate the board with milestones and issues." />
                </Box>
              )
              : columns.map(col => (
                <Column
                  key={col.id}
                  col={col}
                  issues={byColumn[col.id] ?? []}
                  onIssueClick={setProjectsDrawerIssue}
                />
              ))}
        </Row>

        {/* Drawer overlay */}
        {drawerOpen && drawerIssue && (
          <IssueDrawer
            issue={drawerIssue}
            onClose={() => setProjectsDrawerIssue(null)}
          />
        )}
      </section>
    </>
  );
}
