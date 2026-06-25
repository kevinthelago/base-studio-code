import { useState, useEffect } from "react";
import { githubRequest } from "@/features/github/lib/github";
import { useAppStore } from "@/store";
import { ProjectsHeader } from "../list/ProjectsHeader";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";
import {
  buildGantt, tickIntervalWeeks, tickLabel, windowStartFrom,
  WINDOW_PRESETS, DEFAULT_WINDOW_WEEKS,
  type GhMilestone,
} from "./roadmapGantt";

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
  // Filters: time window (clamps the Gantt so milestones aren't spread across the
  // project's whole history) and milestone state.
  const [windowWeeks, setWindowWeeks] = useState<number | null>(DEFAULT_WINDOW_WEEKS);
  const [stateFilter, setStateFilter] = useState<"all" | "open" | "closed">("all");

  // Use the primary repo; fall back to any repo derived from board items.
  const effectiveRepo = activeProjectRepo || activeProjectRepos[0] || "";

  useEffect(() => {
    if (!githubToken || !effectiveRepo) return;
    setLoading(true);
    setError(null);
    githubRequest<GhMilestone[]>(
      `repos/${effectiveRepo}/milestones?state=all&per_page=20&sort=due_on&direction=asc`,
    )
      .then(data => setMilestones(Array.isArray(data) ? data : []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, effectiveRepo]);

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

  // Apply the state filter, then build the windowed Gantt. Stats reflect the
  // filtered set so the cards match what the chart shows.
  const now = new Date();
  const filtered = stateFilter === "all" ? milestones : milestones.filter(m => m.state === stateFilter);
  const { rows, totalWeeks, todayWeek, origin } = buildGantt(filtered, windowStartFrom(windowWeeks, now), now);
  const tickInterval = tickIntervalWeeks(totalWeeks);
  const tickCount    = Math.ceil(totalWeeks / tickInterval) + 1;

  const totalOpen   = filtered.reduce((s, m) => s + m.open_issues, 0);
  const totalClosed = filtered.reduce((s, m) => s + m.closed_issues, 0);
  const totalIssues = totalOpen + totalClosed;
  const velocity = totalIssues > 0 ? (totalClosed / Math.max(todayWeek, 1)).toFixed(1) : "—";

  const stats = [
    { k: "open issues",   v: loading ? "…" : String(totalOpen),   sub: `of ${totalIssues} total`,  tone: "accent"  },
    { k: "milestones",    v: loading ? "…" : String(filtered.length), sub: `${filtered.filter(m => m.state === "closed").length} closed`, tone: "info" },
    { k: "velocity",      v: loading ? "…" : `${velocity}/wk`,     sub: "issues closed per week",   tone: "success" },
    { k: "repo",          v: effectiveRepo.split("/")[1] || "—",    sub: effectiveRepo || "no repo", tone: "muted"   },
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
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>Milestones · weeks</h3>
              <span className="hint">
                {loading ? "loading…"
                  : `${rows.length} shown${milestones.length !== rows.length ? ` of ${milestones.length}` : ""}`}
              </span>
              <div style={{ flex: 1 }} />
              {(() => {
                const chip = (active: boolean, label: string, onClick: () => void) => (
                  <button
                    key={label}
                    onClick={onClick}
                    className="btn"
                    style={{
                      height: 22, fontSize: 10, padding: "0 8px",
                      background: active ? "var(--bg-elev2)" : "var(--bg-elev)",
                      borderColor: active ? "var(--accent-dim)" : "var(--border-soft)",
                      color: active ? "var(--accent)" : "var(--fg-muted)",
                    }}
                  >{label}</button>
                );
                return (
                  <>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>state</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {(["all", "open", "closed"] as const).map(s => chip(stateFilter === s, s, () => setStateFilter(s)))}
                    </div>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginLeft: 6 }}>window</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {WINDOW_PRESETS.map(p => chip(windowWeeks === p.weeks, p.label, () => setWindowWeeks(p.weeks)))}
                    </div>
                  </>
                );
              })()}
            </div>

            {!loading && rows.length === 0 && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0" }}>
                No milestones found for {effectiveRepo || "this project"}.
              </div>
            )}

            {rows.length > 0 && (
              <>
                {/* Week header */}
                <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: 14, marginBottom: 8 }}>
                  <div />
                  <div style={{ position: "relative", height: 24 }}>
                    {Array.from({ length: tickCount }, (_, i) => {
                      const week = i * tickInterval;
                      if (week > totalWeeks) return null;
                      const pct = (week / totalWeeks) * 100;
                      return (
                        <div key={i} style={{
                          position: "absolute", left: `${pct}%`,
                          top: 0, paddingLeft: 4, paddingTop: 4,
                          borderLeft: i === 0 ? "none" : "1px dashed var(--border-soft)",
                          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                          whiteSpace: "nowrap",
                        }}>
                          {tickLabel(week, origin, tickInterval)}
                        </div>
                      );
                    })}
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
                        {Array.from({ length: tickCount }, (_, i) => {
                          const week = i * tickInterval;
                          if (week > totalWeeks) return null;
                          return (
                            <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${(week / totalWeeks) * 100}%`, width: 1, background: "var(--border-soft)" }} />
                          );
                        })}
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
