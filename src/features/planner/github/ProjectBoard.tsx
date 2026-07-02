import { useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { reposFromItems } from "../list/projectScan";
import { GH_OPTION_COLORS } from "@/shared/lib/github/colors";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Chip } from "@/shared/ui/data/Chip";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import type { GhLabel } from "@/shared/lib/github/types";

// ── GitHub data types ─────────────────────────────────────────────────────────

interface GhUser   { login: string }

interface BoardIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: GhLabel[];
  assignees: GhUser[];
  comments: number;
  milestone: string | null;
  state: string;
  focused?: boolean;
}

interface BoardColumn {
  id: string;
  name: string;
  color: string;
}


// ── GraphQL query ─────────────────────────────────────────────────────────────

const BOARD_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      id title
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id name
            options { id name color }
          }
        }
      }
      items(first: 100) {
        nodes {
          id
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name optionId
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number title body state
              repository            { nameWithOwner }
              labels(first: 5)      { nodes { name color } }
              assignees(first: 3)   { nodes { login } }
              comments              { totalCount }
              milestone             { title }
            }
          }
        }
      }
    }
  }
}`;

// ── Sub-components ────────────────────────────────────────────────────────────

function IssueCard({ issue, focused, onClick }: { issue: BoardIssue; focused?: boolean; onClick?: () => void }) {
  return (
    <Stack
      onClick={onClick}
      gap={5}
      style={{
        background: focused ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
        border: "1px solid " + (focused ? "var(--accent-dim)" : "var(--border-soft)"),
        borderRadius: 6, padding: "9px 11px",
        cursor: "pointer",
        boxShadow: focused ? "0 4px 14px rgba(0,0,0,0.25)" : "none",
      }}
    >
      <Row gap={6} align="baseline">
        <Text mono size={10} tone="dim">#{issue.number}</Text>
        {issue.milestone && (
          <Text mono size={9} tone="accent">{issue.milestone}</Text>
        )}
        <Spacer />
      </Row>

      <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg)", lineHeight: 1.4 }}>{issue.title}</div>

      {issue.labels.length > 0 && (
        <Row gap={4} wrap align="stretch">
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </Row>
      )}

      <Row gap={6} style={{ marginTop: 1 }}>
        <Row align="stretch">
          {issue.assignees.length > 0
            ? issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} size={18} ml={i === 0 ? 0 : -6} palette bordered fontScale={0.56} />)
            : <span className="mono" style={{
                width: 18, height: 18, borderRadius: "50%",
                border: "1px dashed var(--border)", color: "var(--fg-dim)",
                fontSize: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>?</span>
          }
        </Row>
        <Spacer />
        {issue.comments > 0 && (
          <Text mono size={9.5} tone="dim">
            💬 {issue.comments}
          </Text>
        )}
      </Row>
    </Stack>
  );
}

function Column({
  col, issues, onIssueClick,
}: { col: BoardColumn; issues: BoardIssue[]; onIssueClick: (n: number) => void }) {
  return (
    <Stack style={{
      flex: "1 1 0", minWidth: 230,
      background: "var(--bg-panel)",
      borderRadius: 8, border: "1px solid var(--border-soft)", overflow: "hidden",
    }}>
      <Row className="mono" gap={8} style={{
        padding: "10px 12px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
        fontSize: 11,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: col.color }} />
        <span style={{ color: "var(--fg)" }}>{col.name}</span>
        <Text tone="dim">{issues.length}</Text>
        <Spacer />
        <Text tone="dim" style={{ cursor: "pointer" }}>+</Text>
        <Text tone="dim" style={{ cursor: "pointer" }}>⋯</Text>
      </Row>
      <Stack gap={7} style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {issues.map(c => (
          <IssueCard key={c.id} issue={c} focused={c.focused} onClick={() => onIssueClick(c.number)} />
        ))}
        <div style={{
          marginTop: 4, padding: "7px 9px",
          border: "1px dashed var(--border)", borderRadius: 5,
          textAlign: "center", fontSize: 10, color: "var(--fg-dim)", cursor: "pointer",
        }} className="mono">+ new card</div>
      </Stack>
    </Stack>
  );
}

// ── Issue drawer ──────────────────────────────────────────────────────────────

function IssueDrawer({ issue, onClose }: { issue: BoardIssue; onClose: () => void }) {
  return (
    <aside style={{
      position: "absolute", top: 0, right: 0, bottom: 0, width: 680,
      background: "var(--bg-panel)",
      borderLeft: "1px solid var(--border)",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
      display: "flex", flexDirection: "column",
      zIndex: 10,
    }}>
      <Row align="start" gap={10} style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
      }}>
        <div style={{ flex: 1 }}>
          <Row gap={10} align="baseline">
            <Text mono size={11} tone="dim">#{issue.number}</Text>
            <h3 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 15, color: "var(--fg)" }}>{issue.title}</h3>
          </Row>
          <Row gap={6} wrap style={{ marginTop: 8 }}>
            <Chip tone={issue.state === "OPEN" ? "accent" : "neutral"} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </Chip>
            {issue.milestone && (
              <Text mono size={10} tone="accent">{issue.milestone}</Text>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </Row>
        </div>
        <Button variant="ghost" style={{ height: 26 }}>open on github →</Button>
        <IconButton aria-label="close" onClick={onClose} />
      </Row>

      <Stack style={{ flex: 1, overflow: "auto" }}>
        {/* Description */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</Text>
          {issue.body ? (
            <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg-muted)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {issue.body.slice(0, 600)}{issue.body.length > 600 ? "…" : ""}
            </div>
          ) : (
            <Text as="div" mono size={11} tone="dim" style={{ fontStyle: "italic" }}>No description.</Text>
          )}
        </div>

        {/* Assignees */}
        {issue.assignees.length > 0 && (
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>assignees</Text>
            <Row gap={8} wrap align="stretch">
              {issue.assignees.map(a => (
                <Row key={a.login} gap={6}>
                  <Avatar login={a.login} size={20} palette bordered fontScale={0.56} />
                  <Text mono size={11} tone="muted">@{a.login}</Text>
                </Row>
              ))}
            </Row>
          </div>
        )}

        {/* Claude subtask breakdown (demo) */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <Row gap={10} align="baseline" style={{ marginBottom: 10 }}>
            <div className="mono" style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontWeight: 700, fontSize: 11,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>C</div>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)" }}>Claude · subtask breakdown</span>
            <Spacer />
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ generate</Button>
          </Row>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic", padding: "8px 10px", background: "var(--bg-canvas)", borderRadius: 5 }}>
            Click "generate" to have Claude break this issue into subtasks.
          </div>
        </div>

        {/* Composer */}
        <Stack gap={8} style={{ padding: "14px 20px", background: "var(--bg-elev)" }}>
          <textarea
            className="input mono"
            placeholder="leave a comment, or /assign, /label, /close, /ai breakdown…"
            style={{ height: 60, padding: "8px 10px", fontSize: 11 }}
          />
          <Row gap={8}>
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>✦ ask claude…</Button>
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>open in pane</Button>
            <Spacer />
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }} onClick={onClose}>close</Button>
            <Button variant="primary" style={{ height: 24, fontSize: 10.5 }}>comment</Button>
          </Row>
        </Stack>
      </Stack>
    </aside>
  );
}

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
