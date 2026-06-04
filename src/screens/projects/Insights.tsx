import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { ProjectsHeader } from "./ProjectsHeader";
import type { ActiveProjectInfo } from "./ProjectsHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

interface InsightIssue {
  id: string;
  number: number;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  comments: number;
  milestone: string | null;
  statusName: string | null;
}

interface StatusOption {
  id: string;
  name: string;
  color: string;  // GH enum e.g. "GREEN"
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

const INSIGHTS_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
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
              number state createdAt updatedAt
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
  "oklch(0.7 0.13 30)", "oklch(0.7 0.10 220)", "oklch(0.68 0.13 145)",
  "oklch(0.7 0.12 290)", "oklch(0.7 0.14 50)", "oklch(0.65 0.08 195)",
];

function loginColor(login: string): string {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// ── Chart primitives ──────────────────────────────────────────────────────────

function HBar({
  label, count, max, color, pct,
}: { label: string; count: number; max: number; color: string; pct?: boolean }) {
  const w = max > 0 ? (count / max) * 100 : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 40px", gap: 10, alignItems: "center" }}>
      <div style={{
        fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{label}</div>
      <div style={{ height: 10, borderRadius: 3, background: "var(--bg-elev2)", overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${w}%`,
          background: color, borderRadius: 3,
          transition: "width 0.3s ease",
        }} />
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>
        {pct ? `${Math.round(w)}%` : count}
      </div>
    </div>
  );
}

function SparkBars({ weeks }: { weeks: Array<{ label: string; opened: number; closed: number }> }) {
  const maxVal = Math.max(...weeks.flatMap(w => [w.opened, w.closed]), 1);
  const barW = 28;
  const gap   = 8;
  const H     = 80;
  const PAD   = { t: 10, b: 20, l: 0, r: 0 };
  const innerH = H - PAD.t - PAD.b;
  const totalW = weeks.length * (barW * 2 + gap + 4);

  return (
    <svg width={totalW} height={H} style={{ display: "block", width: "100%", maxWidth: totalW }}>
      {weeks.map((w, i) => {
        const x = i * (barW * 2 + gap + 4);
        const hO = Math.round((w.opened / maxVal) * innerH);
        const hC = Math.round((w.closed / maxVal) * innerH);
        return (
          <g key={i}>
            {/* opened bar */}
            <rect
              x={x} y={PAD.t + innerH - hO} width={barW} height={hO}
              rx="2" fill="color-mix(in oklch, var(--info), transparent 40%)"
            />
            {/* closed bar */}
            <rect
              x={x + barW + 2} y={PAD.t + innerH - hC} width={barW} height={hC}
              rx="2" fill="color-mix(in oklch, var(--success), transparent 40%)"
            />
            {/* week label */}
            <text
              x={x + barW + 1} y={H - 4}
              textAnchor="middle"
              fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)"
            >{w.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ k, v, sub, tone }: { k: string; v: string; sub: string; tone: "accent" | "info" | "success" | "muted" }) {
  return (
    <div className="card" style={{ padding: "10px 14px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
      <div style={{
        fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, marginTop: 2,
        color: tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : tone === "success" ? "var(--success)" : "var(--fg)",
      }}>{v}</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

// ── Insights screen ───────────────────────────────────────────────────────────

export function Insights() {
  const {
    githubToken,
    activeProjectId, activeProjectName, activeProjectRepo, activeProjectRepos, activeProjectNumber,
  } = useAppStore();

  const [issues, setIssues] = useState<InsightIssue[]>([]);
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!githubToken || !activeProjectId) return;
    setLoading(true);
    setError(null);

    invoke<{ node: Record<string, unknown> }>("github_graphql", {
      token: githubToken,
      query: INSIGHTS_QUERY,
      variables: { id: activeProjectId },
    })
      .then(data => {
        const node = data.node as {
          fields: { nodes: Array<{ id?: string; name?: string; options?: StatusOption[] }> };
          items: { nodes: Array<{
            id: string;
            fieldValues: { nodes: Array<{ name?: string; optionId?: string; field?: { name: string } }> };
            content?: {
              number: number; state: "OPEN" | "CLOSED";
              createdAt: string; updatedAt: string;
              labels: { nodes: Array<{ name: string; color: string }> };
              assignees: { nodes: Array<{ login: string }> };
              comments: { totalCount: number };
              milestone?: { title: string } | null;
            };
          }> };
        };

        const statusField = node.fields.nodes.find(f => f.name === "Status" && f.options);
        setStatusOptions(statusField?.options ?? []);

        const list: InsightIssue[] = [];
        for (const item of node.items.nodes) {
          const typename = (item.content as { __typename?: string } | undefined)?.__typename;
          if (!item.content || typename !== "Issue") continue;
          const c = item.content;
          const statusFv = item.fieldValues.nodes.find(fv => fv.field?.name === "Status");
          list.push({
            id: item.id,
            number: c.number,
            state: c.state,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            labels: c.labels.nodes,
            assignees: c.assignees.nodes,
            comments: c.comments.totalCount,
            milestone: c.milestone?.title ?? null,
            statusName: statusFv?.name ?? null,
          });
        }
        setIssues(list);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, activeProjectId]);

  // ── Derived metrics ─────────────────────────────────────────────────────────

  const open   = useMemo(() => issues.filter(i => i.state === "OPEN").length,   [issues]);
  const closed = useMemo(() => issues.filter(i => i.state === "CLOSED").length, [issues]);
  const total  = issues.length;
  const completionPct = total > 0 ? Math.round((closed / total) * 100) : 0;

  // Status distribution: ordered by statusOptions, ungrouped at end
  const statusDist = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const k = issue.statusName ?? "(no status)";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const ordered = statusOptions.map(o => ({
      name: o.name,
      count: counts[o.name] ?? 0,
      color: GH_OPTION_COLORS[o.color] ?? "var(--fg-dim)",
    }));
    if (counts["(no status)"]) {
      ordered.push({ name: "(no status)", count: counts["(no status)"], color: "var(--bg-elev2)" });
    }
    return ordered;
  }, [issues, statusOptions]);

  // Assignee workload: open issues per login, sorted descending
  const assigneeDist = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues.filter(i => i.state === "OPEN")) {
      if (issue.assignees.length === 0) {
        counts["(unassigned)"] = (counts["(unassigned)"] ?? 0) + 1;
      } else {
        for (const a of issue.assignees) {
          counts[a.login] = (counts[a.login] ?? 0) + 1;
        }
      }
    }
    return Object.entries(counts)
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [issues]);

  // Label frequency: top 12 by count
  const labelDist = useMemo(() => {
    const counts: Record<string, { count: number; color: string }> = {};
    for (const issue of issues) {
      for (const l of issue.labels) {
        if (!counts[l.name]) counts[l.name] = { count: 0, color: `#${l.color}` };
        counts[l.name].count++;
      }
    }
    return Object.entries(counts)
      .map(([name, { count, color }]) => ({ name, count, color }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [issues]);

  // Weekly activity: last 8 weeks bucketed by createdAt (opened) and updatedAt for closed
  const weeklyActivity = useMemo(() => {
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 3600 * 1000;
    const NUM_WEEKS = 8;
    const weeks = Array.from({ length: NUM_WEEKS }, (_, i) => ({
      label: i === NUM_WEEKS - 1 ? "now" : `w-${NUM_WEEKS - 1 - i}`,
      opened: 0,
      closed: 0,
    }));
    for (const issue of issues) {
      const openedAgo  = now - new Date(issue.createdAt).getTime();
      const updatedAgo = now - new Date(issue.updatedAt).getTime();
      const openedBucket  = NUM_WEEKS - 1 - Math.floor(openedAgo  / WEEK_MS);
      const updatedBucket = NUM_WEEKS - 1 - Math.floor(updatedAgo / WEEK_MS);
      if (openedBucket >= 0 && openedBucket < NUM_WEEKS)  weeks[openedBucket].opened++;
      if (issue.state === "CLOSED" && updatedBucket >= 0 && updatedBucket < NUM_WEEKS) {
        weeks[updatedBucket].closed++;
      }
    }
    return weeks;
  }, [issues]);

  const maxStatusCount    = Math.max(...statusDist.map(s => s.count), 1);
  const maxAssigneeCount  = Math.max(...assigneeDist.map(a => a.count), 1);
  const maxLabelCount     = Math.max(...labelDist.map(l => l.count), 1);

  // Velocity: avg issues closed per week over the last 4 weeks
  const velocity = useMemo(() => {
    const last4 = weeklyActivity.slice(-4);
    const avg = last4.reduce((s, w) => s + w.closed, 0) / 4;
    return avg.toFixed(1);
  }, [weeklyActivity]);

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

  const isLoading = loading && issues.length === 0;

  return (
    <>
      <ProjectsHeader project={project} />
      <section style={{ flex: 1, overflow: "auto", padding: "18px 24px" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto" }}>

          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 6, marginBottom: 16,
              background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            }}>{error}</div>
          )}

          {isLoading && (
            <div style={{ padding: "40px 0", textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              Loading insights…
            </div>
          )}

          {!isLoading && (
            <>
              {/* Stat cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
                <StatCard k="total items"   v={String(total)}    sub={`${open} open · ${closed} closed`}         tone="muted"   />
                <StatCard k="completion"    v={`${completionPct}%`} sub={`${closed} of ${total} closed`}          tone="success" />
                <StatCard k="velocity"      v={`${velocity}/wk`} sub="issues closed · last 4 weeks"               tone="info"    />
                <StatCard k="open issues"   v={String(open)}     sub={`${total > 0 ? Math.round((open / total) * 100) : 0}% remaining`} tone="accent" />
              </div>

              {/* Middle row: status + assignees */}
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginBottom: 14 }}>
                {/* Status distribution */}
                <div className="card" style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Status distribution</h3>
                    <span className="hint">{total} items</span>
                  </div>
                  {statusDist.length === 0 ? (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>No status field found.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {statusDist.map(s => (
                        <HBar key={s.name} label={s.name} count={s.count} max={maxStatusCount} color={s.color} />
                      ))}
                    </div>
                  )}
                </div>

                {/* Assignee workload */}
                <div className="card" style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Assignee workload</h3>
                    <span className="hint">open issues</span>
                  </div>
                  {assigneeDist.length === 0 ? (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>No open issues.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {assigneeDist.map(a => (
                        <div key={a.login} style={{ display: "grid", gridTemplateColumns: "18px 112px 1fr 32px", gap: 8, alignItems: "center" }}>
                          {a.login === "(unassigned)" ? (
                            <span style={{
                              width: 16, height: 16, borderRadius: "50%",
                              border: "1px dashed var(--border)", color: "var(--fg-dim)",
                              fontFamily: "var(--mono)", fontSize: 9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>?</span>
                          ) : (
                            <span style={{
                              width: 16, height: 16, borderRadius: "50%",
                              background: loginColor(a.login), color: "#1a120a",
                              fontFamily: "var(--mono)", fontWeight: 700, fontSize: 9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>{a.login[0]?.toUpperCase()}</span>
                          )}
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {a.login}
                          </div>
                          <div style={{ height: 10, borderRadius: 3, background: "var(--bg-elev2)", overflow: "hidden" }}>
                            <div style={{
                              height: "100%",
                              width: `${(a.count / maxAssigneeCount) * 100}%`,
                              background: loginColor(a.login === "(unassigned)" ? "?" : a.login),
                              borderRadius: 3,
                            }} />
                          </div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{a.count}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Weekly activity */}
              <div className="card" style={{ padding: "16px 20px", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
                  <h3 style={{ margin: 0 }}>Weekly activity</h3>
                  <span className="hint">last 8 weeks</span>
                  <div style={{ flex: 1 }} />
                  <div style={{ display: "flex", gap: 14, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: "color-mix(in oklch, var(--info), transparent 40%)", display: "inline-block" }} />
                      opened
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: "color-mix(in oklch, var(--success), transparent 40%)", display: "inline-block" }} />
                      closed
                    </span>
                  </div>
                </div>
                <SparkBars weeks={weeklyActivity} />
              </div>

              {/* Label distribution */}
              {labelDist.length > 0 && (
                <div className="card" style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Label frequency</h3>
                    <span className="hint">top {labelDist.length}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 32px" }}>
                    {labelDist.map(l => (
                      <HBar key={l.name} label={l.name} count={l.count} max={maxLabelCount} color={l.color} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </section>
    </>
  );
}
