import { useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { reposFromItems } from "../list/projectScan";
import { GH_OPTION_COLORS } from "@/shared/lib/github/colors";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Avatar } from "@/shared/ui/Avatar";
import { LabelChip } from "@/shared/ui/LabelChip";
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
    <div
      onClick={onClick}
      style={{
        background: focused ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
        border: "1px solid " + (focused ? "var(--accent-dim)" : "var(--border-soft)"),
        borderRadius: 6, padding: "9px 11px",
        display: "flex", flexDirection: "column", gap: 5,
        cursor: "pointer",
        boxShadow: focused ? "0 4px 14px rgba(0,0,0,0.25)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{issue.number}</span>
        {issue.milestone && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>{issue.milestone}</span>
        )}
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg)", lineHeight: 1.4 }}>{issue.title}</div>

      {issue.labels.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
        <div style={{ display: "flex" }}>
          {issue.assignees.length > 0
            ? issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} size={18} ml={i === 0 ? 0 : -6} palette bordered fontScale={0.56} />)
            : <span style={{
                width: 18, height: 18, borderRadius: "50%",
                border: "1px dashed var(--border)", color: "var(--fg-dim)",
                fontFamily: "var(--mono)", fontSize: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>?</span>
          }
        </div>
        <div style={{ flex: 1 }} />
        {issue.comments > 0 && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
            💬 {issue.comments}
          </span>
        )}
      </div>
    </div>
  );
}

function Column({
  col, issues, onIssueClick,
}: { col: BoardColumn; issues: BoardIssue[]; onIssueClick: (n: number) => void }) {
  return (
    <div style={{
      flex: "1 1 0", minWidth: 230,
      display: "flex", flexDirection: "column",
      background: "var(--bg-panel)",
      borderRadius: 8, border: "1px solid var(--border-soft)", overflow: "hidden",
    }}>
      <div style={{
        padding: "10px 12px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: "var(--mono)", fontSize: 11,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: col.color }} />
        <span style={{ color: "var(--fg)" }}>{col.name}</span>
        <span style={{ color: "var(--fg-dim)" }}>{issues.length}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)", cursor: "pointer" }}>+</span>
        <span style={{ color: "var(--fg-dim)", cursor: "pointer" }}>⋯</span>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
        {issues.map(c => (
          <IssueCard key={c.id} issue={c} focused={c.focused} onClick={() => onIssueClick(c.number)} />
        ))}
        <div style={{
          marginTop: 4, padding: "7px 9px",
          border: "1px dashed var(--border)", borderRadius: 5,
          textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", cursor: "pointer",
        }}>+ new card</div>
      </div>
    </div>
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
      <div style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
        display: "flex", alignItems: "flex-start", gap: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>#{issue.number}</span>
            <h3 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 15, color: "var(--fg)" }}>{issue.title}</h3>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className={`tag ${issue.state === "OPEN" ? "amber" : ""}`} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </span>
            {issue.milestone && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)" }}>{issue.milestone}</span>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </div>
        </div>
        <button className="btn ghost" style={{ height: 26 }}>open on github →</button>
        <button className="btn ghost" style={{ height: 26, padding: "0 8px" }} onClick={onClose}>✕</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {/* Description */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</div>
          {issue.body ? (
            <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg-muted)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {issue.body.slice(0, 600)}{issue.body.length > 600 ? "…" : ""}
            </div>
          ) : (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic" }}>No description.</div>
          )}
        </div>

        {/* Assignees */}
        {issue.assignees.length > 0 && (
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>assignees</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {issue.assignees.map(a => (
                <div key={a.login} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar login={a.login} size={20} palette bordered fontScale={0.56} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>@{a.login}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Claude subtask breakdown (demo) */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>C</div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)" }}>Claude · subtask breakdown</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ generate</button>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic", padding: "8px 10px", background: "var(--bg-canvas)", borderRadius: 5 }}>
            Click "generate" to have Claude break this issue into subtasks.
          </div>
        </div>

        {/* Composer */}
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-elev)" }}>
          <textarea
            className="input"
            placeholder="leave a comment, or /assign, /label, /close, /ai breakdown…"
            style={{ height: 60, padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 11 }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>✦ ask claude…</button>
            <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>open in pane</button>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }} onClick={onClose}>close</button>
            <button className="btn primary" style={{ height: 24, fontSize: 10.5 }}>comment</button>
          </div>
        </div>
      </div>
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
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-canvas)", zIndex: 5,
            fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
          }}>
            Loading board…
          </div>
        )}

        <QueryBanner error={error} style={{ margin: 8 }} />

        {/* Board columns */}
        <div style={{
          display: "flex", gap: 10, height: "100%", overflow: "auto",
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
        </div>

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
