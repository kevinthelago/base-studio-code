import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { ProjectsHeader } from "./ProjectsHeader";
import type { ActiveProjectInfo } from "./ProjectsHeader";

interface GhMilestone {
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  due_on: string | null;
  created_at: string;
  open_issues: number;
  closed_issues: number;
  creator: { login: string } | null;
}

interface GanttRow {
  id: string;
  title: string;
  startWeek: number;
  lengthWeeks: number;
  pct: number;
  state: "done" | "doing" | "upcoming" | "backlog";
  creator: string;
  dueLabel: string;
}

function weeksBetween(a: Date, b: Date): number {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (7 * 24 * 3600 * 1000)));
}

function buildGantt(milestones: GhMilestone[]): { rows: GanttRow[]; totalWeeks: number; todayWeek: number } {
  if (milestones.length === 0) return { rows: [], totalWeeks: 8, todayWeek: 0 };

  const starts = milestones.map(m => new Date(m.created_at));
  const origin = starts.reduce((a, b) => a < b ? a : b);
  const today = new Date();
  const todayWeek = weeksBetween(origin, today);

  const ends = milestones.map(m => m.due_on ? new Date(m.due_on) : new Date(new Date(m.created_at).getTime() + 14 * 24 * 3600 * 1000));
  const horizon = ends.reduce((a, b) => a > b ? a : b);
  const totalWeeks = Math.max(weeksBetween(origin, horizon) + 1, 8);

  const rows: GanttRow[] = milestones.map((m, i) => {
    const start = starts[i];
    const end = ends[i];
    const startWeek = weeksBetween(origin, start);
    const lengthWeeks = Math.max(1, weeksBetween(start, end));
    const total = m.open_issues + m.closed_issues;
    const pct = total > 0 ? m.closed_issues / total : 0;
    const state: GanttRow["state"] =
      m.state === "closed" ? "done"
      : pct > 0 ? "doing"
      : startWeek <= todayWeek ? "upcoming"
      : "backlog";

    const dueLabel = m.due_on
      ? new Date(m.due_on).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "no due date";

    return {
      id: String(m.number),
      title: m.title,
      startWeek, lengthWeeks, pct, state,
      creator: m.creator?.login ?? "",
      dueLabel,
    };
  });

  return { rows, totalWeeks, todayWeek };
}

function BurnDown({ open, closed }: { open: number; closed: number }) {
  const total = open + closed;
  if (total === 0) {
    return (
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0" }}>
        No issue data available.
      </div>
    );
  }
  // Simple two-point chart: total issues created vs closed
  const W = 1140, H = 120, PAD = { l: 36, r: 20, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x0 = PAD.l, x1 = PAD.l + innerW;
  const yVal = (v: number) => PAD.t + (1 - v / total) * innerH;
  const idealPath = `M ${x0} ${yVal(total)} L ${x1} ${yVal(0)}`;
  const actualPath = `M ${x0} ${yVal(total)} L ${x1} ${yVal(open)}`;

  return (
    <svg width={W} height={H} style={{ width: "100%", maxWidth: W, display: "block" }}>
      {[0, Math.round(total / 2), total].map(v => (
        <g key={v}>
          <line x1={PAD.l} y1={yVal(v)} x2={W - PAD.r} y2={yVal(v)} stroke="var(--border-soft)" strokeDasharray="2 3" />
          <text x={PAD.l - 4} y={yVal(v) + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{v}</text>
        </g>
      ))}
      <path d={idealPath} fill="none" stroke="var(--fg-dim)" strokeDasharray="3 4" strokeWidth="1.5" />
      <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <circle cx={x0} cy={yVal(total)} r="3" fill="var(--accent)" />
      <circle cx={x1} cy={yVal(open)} r="3" fill="var(--accent)" />
      <text x={x1 - 2} y={yVal(open) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">open · {open}</text>
      <text x={x1 - 2} y={yVal(0) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">ideal · 0</text>
    </svg>
  );
}

export function Roadmap() {
  const {
    githubToken,
    activeProjectId, activeProjectName, activeProjectRepo, activeProjectRepos, activeProjectNumber,
  } = useAppStore();

  const [milestones, setMilestones] = useState<GhMilestone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!githubToken || !activeProjectRepo) return;
    setLoading(true);
    setError(null);
    invoke<GhMilestone[]>("github_request", {
      token: githubToken,
      path: `repos/${activeProjectRepo}/milestones?state=all&per_page=20&sort=due_on&direction=asc`,
    })
      .then(data => setMilestones(Array.isArray(data) ? data : []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, activeProjectRepo]);

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

  const { rows, totalWeeks, todayWeek } = buildGantt(milestones);

  const totalOpen   = milestones.reduce((s, m) => s + m.open_issues, 0);
  const totalClosed = milestones.reduce((s, m) => s + m.closed_issues, 0);
  const totalIssues = totalOpen + totalClosed;
  const velocity = totalIssues > 0 ? (totalClosed / Math.max(todayWeek, 1)).toFixed(1) : "—";

  const stats = [
    { k: "open issues",   v: loading ? "…" : String(totalOpen),   sub: `of ${totalIssues} total`,  tone: "accent"  },
    { k: "milestones",    v: loading ? "…" : String(milestones.length), sub: `${milestones.filter(m => m.state === "closed").length} closed`, tone: "info" },
    { k: "velocity",      v: loading ? "…" : `${velocity}/wk`,     sub: "issues closed per week",   tone: "success" },
    { k: "repo",          v: activeProjectRepo.split("/")[1] ?? "—", sub: activeProjectRepo,         tone: "muted"   },
  ] as const;

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

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
            {stats.map(({ k, v, sub, tone }) => (
              <div key={k} className="card" style={{ padding: "10px 14px" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, marginTop: 2,
                  color: tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : tone === "success" ? "var(--success)" : "var(--fg)",
                }}>{v}</div>
                <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Gantt */}
          <div className="card" style={{ padding: "16px 20px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Milestones · weeks</h3>
              <span className="hint">
                {loading ? "loading…" : `${milestones.length} milestone${milestones.length !== 1 ? "s" : ""}`}
              </span>
            </div>

            {!loading && rows.length === 0 && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0" }}>
                No milestones found for {activeProjectRepo}.
              </div>
            )}

            {rows.length > 0 && (
              <>
                {/* Week header */}
                <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: 14, marginBottom: 8 }}>
                  <div />
                  <div style={{ position: "relative", height: 24, display: "grid", gridTemplateColumns: `repeat(${totalWeeks}, 1fr)` }}>
                    {Array.from({ length: totalWeeks }, (_, i) => (
                      <div key={i} style={{
                        fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                        borderLeft: i === 0 ? "none" : "1px dashed var(--border-soft)",
                        paddingLeft: 6, paddingTop: 4,
                      }}>w{i + 1}</div>
                    ))}
                    {todayWeek < totalWeeks && (
                      <div style={{
                        position: "absolute", top: 0, bottom: -300,
                        left: `${(todayWeek / totalWeeks) * 100}%`,
                        width: 0, borderLeft: "1.5px dashed var(--accent)", zIndex: 2,
                      }}>
                        <span style={{ position: "absolute", top: -2, left: 4, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>today</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Milestone rows */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {rows.map(m => (
                    <div key={m.id} style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: 14, alignItems: "center" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>M{m.id}</span>
                          <span style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg)" }}>{m.title}</span>
                        </div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>
                          due {m.dueLabel}
                        </div>
                      </div>
                      <div style={{ position: "relative", height: 32 }}>
                        {Array.from({ length: totalWeeks }, (_, i) => (
                          <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${(i / totalWeeks) * 100}%`, width: 1, background: "var(--border-soft)" }} />
                        ))}
                        <div style={{
                          position: "absolute", top: 4, bottom: 4,
                          left: `${(m.startWeek / totalWeeks) * 100}%`,
                          width: `${(m.lengthWeeks / totalWeeks) * 100}%`,
                          borderRadius: 5, overflow: "hidden",
                          display: "flex", alignItems: "center",
                          background:
                            m.state === "done"     ? "color-mix(in oklch, var(--success), transparent 60%)"
                            : m.state === "doing"  ? "color-mix(in oklch, var(--accent), transparent 70%)"
                            : m.state === "upcoming" ? "color-mix(in oklch, var(--info), transparent 80%)"
                            : "var(--bg-elev2)",
                          border: "1px solid " + (
                            m.state === "done"     ? "color-mix(in oklch, var(--success), transparent 40%)"
                            : m.state === "doing"  ? "var(--accent-dim)"
                            : m.state === "upcoming" ? "color-mix(in oklch, var(--info), transparent 60%)"
                            : "var(--border-soft)"
                          ),
                        }}>
                          {m.pct > 0 && (
                            <div style={{
                              position: "absolute", inset: 0, width: `${m.pct * 100}%`,
                              background: "color-mix(in oklch, var(--accent), transparent 40%)",
                            }} />
                          )}
                          <span style={{
                            position: "relative", padding: "0 10px",
                            fontFamily: "var(--mono)", fontSize: 10.5,
                            color: m.state === "backlog" ? "var(--fg-muted)" : "var(--fg)",
                            whiteSpace: "nowrap",
                          }}>
                            {m.lengthWeeks}w · {m.pct > 0 ? `${Math.round(m.pct * 100)}% done` : m.state}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Burn-down */}
          <div className="card" style={{ padding: "16px 20px", marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Issue progress</h3>
              <span className="hint">{totalIssues} total · {totalClosed} closed · {totalOpen} remaining</span>
            </div>
            <BurnDown open={totalOpen} closed={totalClosed} />
          </div>
        </div>
      </section>
    </>
  );
}
