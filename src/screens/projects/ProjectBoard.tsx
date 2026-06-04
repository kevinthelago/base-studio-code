import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { ProjectsHeader } from "./ProjectsHeader";
import type { ActiveProjectInfo } from "./ProjectsHeader";
import { reposFromItems } from "./projectScan";

// ── GitHub data types ─────────────────────────────────────────────────────────

interface GhLabel  { name: string; color: string }
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

// ── Color helpers ─────────────────────────────────────────────────────────────

const GH_OPTION_COLORS: Record<string, string> = {
  GRAY:   "var(--fg-dim)",
  BLUE:   "var(--info)",
  GREEN:  "var(--success)",
  YELLOW: "oklch(0.78 0.14 70)",
  ORANGE: "var(--accent)",
  RED:    "var(--danger)",
  PINK:   "oklch(0.7 0.18 340)",
  PURPLE: "oklch(0.68 0.13 290)",
};

const AVATAR_PALETTE = [
  "oklch(0.7 0.13 30)",
  "oklch(0.7 0.10 220)",
  "oklch(0.68 0.13 145)",
  "oklch(0.7 0.12 290)",
  "oklch(0.7 0.14 50)",
  "oklch(0.65 0.08 195)",
];

function loginColor(login: string): string {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
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

function LabelChip({ label }: { label: GhLabel }) {
  const color = `#${label.color}`;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "1px 6px", borderRadius: 99,
      fontFamily: "var(--mono)", fontSize: 9,
      background: `${color}22`,
      color,
      border: `1px solid ${color}55`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {label.name}
    </span>
  );
}

function Avatar({ login, size = 18, ml = 0 }: { login: string; size?: number; ml?: number }) {
  return (
    <span title={"@" + login} style={{
      width: size, height: size, borderRadius: "50%",
      background: loginColor(login), color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * 0.56,
      display: "flex", alignItems: "center", justifyContent: "center",
      marginLeft: ml,
      border: "1.5px solid var(--bg-canvas)",
    }}>{login[0]?.toUpperCase() ?? "?"}</span>
  );
}

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
            ? issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} ml={i === 0 ? 0 : -6} />)
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
                  <Avatar login={a.login} size={20} />
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
  const {
    githubToken,
    activeProjectId, activeProjectName, activeProjectRepo, activeProjectRepos, activeProjectNumber,
    projectsDrawerIssue, setProjectsDrawerIssue, setActiveProjectRepos,
  } = useAppStore();

  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [byColumn, setByColumn] = useState<Record<string, BoardIssue[]>>({});
  const [allItems, setAllItems] = useState<BoardIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!githubToken || !activeProjectId) return;
    setLoading(true);
    setError(null);

    invoke<{ node: Record<string, unknown> }>("github_graphql", {
      token: githubToken,
      query: BOARD_QUERY,
      variables: { id: activeProjectId },
    })
      .then(data => {
        const node = data.node as {
          fields: { nodes: Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string; color: string }> }> };
          items: { nodes: Array<{
            id: string;
            fieldValues: { nodes: Array<{ name?: string; optionId?: string; field?: { name: string } }> };
            content?: {
              number: number; title: string; body: string; state: string;
              repository: { nameWithOwner: string };
              labels: { nodes: GhLabel[] };
              assignees: { nodes: GhUser[] };
              comments: { totalCount: number };
              milestone?: { title: string } | null;
            };
          }> };
        };

        // Find the Status single-select field
        const statusField = node.fields.nodes.find(f => f.name === "Status" && f.options);
        const cols: BoardColumn[] = statusField?.options?.map(o => ({
          id: o.id,
          name: o.name,
          color: GH_OPTION_COLORS[o.color] ?? "var(--fg-dim)",
        })) ?? [{ id: "all", name: "All items", color: "var(--fg-dim)" }];

        // Map items to BoardIssue
        const grouped: Record<string, BoardIssue[]> = {};
        const flat: BoardIssue[] = [];
        cols.forEach(c => { grouped[c.id] = []; });

        for (const item of node.items.nodes) {
          const typename = (item.content as { __typename?: string } | undefined)?.__typename;
          if (!item.content || typename !== "Issue") continue;
          const c = item.content;
          const issue: BoardIssue = {
            id: item.id,
            number: c.number,
            title: c.title,
            body: c.body ?? "",
            labels: c.labels.nodes,
            assignees: c.assignees.nodes,
            comments: c.comments.totalCount,
            milestone: c.milestone?.title ?? null,
            state: c.state,
          };
          flat.push(issue);

          // Find which Status option this item has
          const statusValue = item.fieldValues.nodes.find(fv => fv.field?.name === "Status");
          const colId = statusValue?.optionId ?? (cols[0]?.id ?? "all");
          if (grouped[colId]) grouped[colId].push(issue);
          else grouped[cols[0]?.id ?? "all"] = [...(grouped[cols[0]?.id ?? "all"] ?? []), issue];
        }

        // Derive repos from the issues themselves — more reliable than the
        // project-level repositories field, which requires explicit linking in GitHub UI.
        const repos = reposFromItems(node.items.nodes);
        if (repos.length > 0) setActiveProjectRepos(repos);

        setColumns(cols);
        setByColumn(grouped);
        setAllItems(flat);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, activeProjectId]);

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

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

        {error && (
          <div style={{
            padding: "12px 16px", borderRadius: 6, margin: 8,
            background: "color-mix(in oklch, var(--danger), transparent 88%)",
            border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
          }}>{error}</div>
        )}

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
