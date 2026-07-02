import { useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { reposFromItems } from "../list/projectScan";
import { GH_OPTION_COLORS } from "@/shared/lib/github/colors";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Row } from "@/shared/ui/layout/Row";
import type { GhLabel } from "@/shared/lib/github/types";
import { BOARD_QUERY } from "./projectBoard.query";
import type { GhUser, BoardIssue, BoardColumn } from "./projectBoard.types";
import { Column } from "./Column";
import { IssueDrawer } from "./IssueDrawer";

// ── Board ─────────────────────────────────────────────────────────────────────

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
        {loading && (
          <Row align="center" justify="center" className="mono" style={{
            position: "absolute", inset: 0,
            background: "var(--bg-canvas)", zIndex: 5,
            fontSize: 12, color: "var(--fg-dim)",
          }}>
            Loading board…
          </Row>
        )}

        <QueryBanner error={error} style={{ margin: 8 }} />

        {/* Board columns */}
        <Row gap={10} align="stretch" style={{
          height: "100%", overflow: "auto",
          opacity: drawerOpen ? 0.35 : 1,
          pointerEvents: drawerOpen ? "none" : undefined,
          transition: "opacity 0.15s",
        }}>
          {columns.map(col => (
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
