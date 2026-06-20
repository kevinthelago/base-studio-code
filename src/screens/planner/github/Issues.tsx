import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../../store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GhLabel { name: string; color: string }
interface GhUser  { login: string }

interface FlatIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  labels: GhLabel[];
  assignees: GhUser[];
  comments: number;
  milestone: string | null;
  statusName: string | null;   // project Status field value
}

// ── GraphQL query ─────────────────────────────────────────────────────────────

const ISSUES_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number title body state updatedAt
              labels(first: 5)    { nodes { name color } }
              assignees(first: 3) { nodes { login } }
              comments            { totalCount }
              milestone           { title }
            }
          }
        }
      }
    }
  }
}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  "oklch(0.7 0.13 30)", "oklch(0.7 0.10 220)", "oklch(0.68 0.13 145)",
  "oklch(0.7 0.12 290)", "oklch(0.7 0.14 50)", "oklch(0.65 0.08 195)",
];

function loginColor(login: string): string {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LabelChip({ label }: { label: GhLabel }) {
  const color = `#${label.color}`;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "1px 5px", borderRadius: 99,
      fontFamily: "var(--mono)", fontSize: 9,
      background: `${color}22`, color,
      border: `1px solid ${color}55`,
      whiteSpace: "nowrap",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {label.name}
    </span>
  );
}

function Avatar({ login, size = 16, ml = 0 }: { login: string; size?: number; ml?: number }) {
  return (
    <span title={"@" + login} style={{
      width: size, height: size, borderRadius: "50%",
      background: loginColor(login), color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * 0.56,
      display: "flex", alignItems: "center", justifyContent: "center",
      marginLeft: ml, border: "1.5px solid var(--bg-canvas)", flexShrink: 0,
    }}>{login[0]?.toUpperCase() ?? "?"}</span>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ issue, onClose }: { issue: FlatIssue; onClose: () => void }) {
  return (
    <aside style={{
      position: "absolute", top: 0, right: 0, bottom: 0, width: 600,
      background: "var(--bg-panel)", borderLeft: "1px solid var(--border)",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
      display: "flex", flexDirection: "column", zIndex: 10,
    }}>
      {/* Header */}
      <div style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)", display: "flex", alignItems: "flex-start", gap: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>#{issue.number}</span>
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--fg)" }}>{issue.title}</h3>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className={`tag ${issue.state === "OPEN" ? "amber" : ""}`} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </span>
            {issue.statusName && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                {issue.statusName}
              </span>
            )}
            {issue.milestone && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)" }}>{issue.milestone}</span>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </div>
        </div>
        <button className="btn ghost" style={{ height: 26 }}>open on github →</button>
        <button className="btn ghost" style={{ height: 26, padding: "0 8px" }} onClick={onClose}>✕</button>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Body */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</div>
          {issue.body ? (
            <div style={{ fontSize: 12.5, color: "var(--fg-muted)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {issue.body.slice(0, 800)}{issue.body.length > 800 ? "…" : ""}
            </div>
          ) : (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic" }}>No description.</div>
          )}
        </div>

        {/* Meta */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 10 }}>
          {issue.assignees.length > 0 && (
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>assignees</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {issue.assignees.map(a => (
                  <div key={a.login} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Avatar login={a.login} size={18} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>@{a.login}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 24, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
            {issue.comments > 0 && <span>💬 {issue.comments} comment{issue.comments !== 1 ? "s" : ""}</span>}
            <span>updated {timeAgo(issue.updatedAt)} ago</span>
          </div>
        </div>

        {/* Claude breakdown */}
        <div style={{ padding: "14px 20px", background: "var(--bg-elev)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>C</div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>Claude</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ break down</button>
            <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>open in pane</button>
          </div>
          <textarea
            className="input"
            placeholder="ask claude about this issue…"
            style={{ width: "100%", height: 54, padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 11, boxSizing: "border-box" }}
          />
        </div>
      </div>
    </aside>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

type StateFilter  = "all" | "open" | "closed";
type SortKey      = "newest" | "oldest" | "number" | "comments";

interface Filters {
  search: string;
  state: StateFilter;
  label: string;
  milestone: string;
  sort: SortKey;
}

function FilterBar({
  filters, onChange, labels, milestones, total, shown,
}: {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  labels: string[];
  milestones: string[];
  total: number;
  shown: number;
}) {
  const stateOpts: { k: StateFilter; label: string }[] = [
    { k: "all",    label: "all"    },
    { k: "open",   label: "open"   },
    { k: "closed", label: "closed" },
  ];

  const selectStyle = {
    height: 26, fontSize: 10.5,
    fontFamily: "var(--mono)", background: "var(--bg-elev)",
    border: "1px solid var(--border-soft)", borderRadius: 4,
    color: "var(--fg-muted)", padding: "0 6px", cursor: "pointer",
  };

  return (
    <div style={{
      padding: "10px 16px", borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
      display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    }}>
      <input
        className="input"
        placeholder="⌕ filter issues…"
        value={filters.search}
        onChange={e => onChange({ search: e.target.value })}
        style={{ height: 26, width: 220, fontSize: 11 }}
      />

      <div style={{ display: "flex", gap: 1, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
        {stateOpts.map(({ k, label }) => (
          <button
            key={k}
            onClick={() => onChange({ state: k })}
            style={{
              height: 26, padding: "0 10px",
              fontFamily: "var(--mono)", fontSize: 10.5,
              background: filters.state === k ? "var(--bg-elev2)" : "var(--bg-elev)",
              border: "none", borderRight: k !== "closed" ? "1px solid var(--border-soft)" : "none",
              color: filters.state === k ? "var(--fg)" : "var(--fg-muted)",
              cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </div>

      {labels.length > 0 && (
        <select
          style={selectStyle}
          value={filters.label}
          onChange={e => onChange({ label: e.target.value })}
        >
          <option value="">label: all</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}

      {milestones.length > 0 && (
        <select
          style={selectStyle}
          value={filters.milestone}
          onChange={e => onChange({ milestone: e.target.value })}
        >
          <option value="">milestone: all</option>
          {milestones.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      )}

      <div style={{ flex: 1 }} />

      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
        {shown === total ? `${total} issues` : `${shown} of ${total}`}
      </span>

      <select
        style={selectStyle}
        value={filters.sort}
        onChange={e => onChange({ sort: e.target.value as SortKey })}
      >
        <option value="newest">sort: newest</option>
        <option value="oldest">oldest</option>
        <option value="number">number ↓</option>
        <option value="comments">most comments</option>
      </select>
    </div>
  );
}

// ── Issue row ─────────────────────────────────────────────────────────────────

function IssueRow({ issue, selected, onClick }: { issue: FlatIssue; selected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "44px 1fr 180px 80px 50px 48px",
        gap: 10, alignItems: "center",
        padding: "9px 16px",
        background: selected ? "color-mix(in oklch, var(--accent), transparent 93%)" : "transparent",
        borderBottom: "1px solid var(--border-soft)",
        cursor: "pointer",
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elev)"; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    >
      {/* Number + state */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: issue.state === "OPEN" ? "var(--success)" : "var(--fg-dim)",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
          {issue.number}
        </span>
      </div>

      {/* Title + labels */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, color: "var(--fg)", marginBottom: 4,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{issue.title}</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {issue.statusName && (
            <span style={{
              padding: "1px 5px", borderRadius: 3,
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
              background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
            }}>{issue.statusName}</span>
          )}
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </div>
      </div>

      {/* Assignees + milestone */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {issue.assignees.length > 0 && (
          <div style={{ display: "flex" }}>
            {issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} ml={i === 0 ? 0 : -5} />)}
            <span style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", marginLeft: 6,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {issue.assignees.map(a => a.login).join(", ")}
            </span>
          </div>
        )}
        {issue.milestone && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", whiteSpace: "nowrap" }}>
            ◈ {issue.milestone}
          </span>
        )}
      </div>

      {/* Comments */}
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", textAlign: "center" }}>
        {issue.comments > 0 ? `💬 ${issue.comments}` : "—"}
      </div>

      {/* Updated */}
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>
        {timeAgo(issue.updatedAt)}
      </div>

      {/* Open in pane */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          className="btn ghost"
          style={{ height: 22, padding: "0 7px", fontSize: 9.5 }}
          onClick={e => { e.stopPropagation(); }}
        >⊕</button>
      </div>
    </div>
  );
}

// ── Issues screen ─────────────────────────────────────────────────────────────

export function Issues() {
  const {
    githubToken,
    activeProjectId, activeProjectName, activeProjectRepo, activeProjectRepos, activeProjectNumber,
  } = useAppStore();

  const [rawIssues, setRawIssues] = useState<FlatIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<FlatIssue | null>(null);
  const [filters, setFilters] = useState<Filters>({
    search: "", state: "open", label: "", milestone: "", sort: "newest",
  });

  useEffect(() => {
    if (!githubToken || !activeProjectId) return;
    setLoading(true);
    setError(null);

    invoke<{ node: Record<string, unknown> }>("github_graphql", {
      token: githubToken,
      query: ISSUES_QUERY,
      variables: { id: activeProjectId },
    })
      .then(data => {
        const node = data.node as {
          items: { nodes: Array<{
            id: string;
            fieldValues: { nodes: Array<{ name?: string; field?: { name: string } }> };
            content?: {
              number: number; title: string; body: string;
              state: "OPEN" | "CLOSED"; updatedAt: string;
              labels: { nodes: Array<{ name: string; color: string }> };
              assignees: { nodes: Array<{ login: string }> };
              comments: { totalCount: number };
              milestone?: { title: string } | null;
            };
          }> };
        };

        const issues: FlatIssue[] = [];
        for (const item of node.items.nodes) {
          const typename = (item.content as { __typename?: string } | undefined)?.__typename;
          if (!item.content || typename !== "Issue") continue;
          const c = item.content;
          const statusFv = item.fieldValues.nodes.find(fv => fv.field?.name === "Status");
          issues.push({
            id: item.id,
            number: c.number,
            title: c.title,
            body: c.body ?? "",
            state: c.state,
            updatedAt: c.updatedAt,
            labels: c.labels.nodes,
            assignees: c.assignees.nodes,
            comments: c.comments.totalCount,
            milestone: c.milestone?.title ?? null,
            statusName: statusFv?.name ?? null,
          });
        }
        setRawIssues(issues);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, activeProjectId]);

  const updateFilters = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

  const allLabels = useMemo(
    () => [...new Set(rawIssues.flatMap(i => i.labels.map(l => l.name)))].sort(),
    [rawIssues],
  );
  const allMilestones = useMemo(
    () => [...new Set(rawIssues.map(i => i.milestone).filter((m): m is string => m !== null))].sort(),
    [rawIssues],
  );

  const filtered = useMemo(() => {
    let list = rawIssues;
    if (filters.state !== "all") {
      list = list.filter(i => i.state === (filters.state === "open" ? "OPEN" : "CLOSED"));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(i =>
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q) ||
        i.labels.some(l => l.name.toLowerCase().includes(q))
      );
    }
    if (filters.label) {
      list = list.filter(i => i.labels.some(l => l.name === filters.label));
    }
    if (filters.milestone) {
      list = list.filter(i => i.milestone === filters.milestone);
    }
    switch (filters.sort) {
      case "newest":   return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      case "oldest":   return [...list].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      case "number":   return [...list].sort((a, b) => b.number - a.number);
      case "comments": return [...list].sort((a, b) => b.comments - a.comments);
      default:         return list;
    }
  }, [rawIssues, filters]);

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

  const panelOpen = selectedIssue !== null;

  return (
    <>
      <ProjectsHeader project={project} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
        <FilterBar
          filters={filters}
          onChange={updateFilters}
          labels={allLabels}
          milestones={allMilestones}
          total={rawIssues.length}
          shown={filtered.length}
        />

        {/* Column header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "44px 1fr 180px 80px 50px 48px",
          gap: 10, padding: "6px 16px",
          borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg-panel)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".05em",
        }}>
          <div>#</div>
          <div>title</div>
          <div>assignee · milestone</div>
          <div style={{ textAlign: "center" }}>comments</div>
          <div style={{ textAlign: "right" }}>updated</div>
          <div />
        </div>

        <div style={{ flex: 1, overflow: "auto", background: "var(--bg-canvas)", position: "relative" }}>
          {loading && rawIssues.length === 0 && (
            <div style={{ padding: "40px 0", textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              Loading issues…
            </div>
          )}

          {error && (
            <div style={{
              margin: 12, padding: "12px 16px", borderRadius: 6,
              background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            }}>{error}</div>
          )}

          {!loading && !error && filtered.length === 0 && rawIssues.length > 0 && (
            <div style={{ padding: "40px 0", textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              No issues match the current filters.
            </div>
          )}

          {!loading && !error && rawIssues.length === 0 && !error && (
            <div style={{ padding: "40px 0", textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              No issues found in this project.
            </div>
          )}

          <div style={{
            opacity: panelOpen ? 0.35 : 1,
            pointerEvents: panelOpen ? "none" : undefined,
            transition: "opacity 0.15s",
          }}>
            {filtered.map(issue => (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={selectedIssue?.id === issue.id}
                onClick={() => setSelectedIssue(selectedIssue?.id === issue.id ? null : issue)}
              />
            ))}
          </div>

          {panelOpen && selectedIssue && (
            <DetailPanel issue={selectedIssue} onClose={() => setSelectedIssue(null)} />
          )}
        </div>
      </div>
    </>
  );
}
