import { useState } from "react";
import { githubRequest } from "@/shared/lib/github/github";
import { useGithubQuery } from "@/features/github/lib/useGithubQuery";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProject, QueryBanner } from "./useActiveProjectGithub";
import {
  buildGantt, tickIntervalWeeks, tickLabel, windowStartFrom,
  WINDOW_PRESETS, DEFAULT_WINDOW_WEEKS,
  type GhMilestone,
} from "./roadmapGantt";
import { StatCard } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";

function BurnDown({ open, closed }: { open: number; closed: number }) {
  const total = open + closed;
  if (total === 0) {
    return (
      <Text as="div" mono size={11} tone="dim" style={{ padding: "20px 0" }}>
        No issue data available.
      </Text>
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
  const project = useActiveProject();

  // Filters: time window (clamps the Gantt so milestones aren't spread across the
  // project's whole history) and milestone state.
  const [windowWeeks, setWindowWeeks] = useState<number | null>(DEFAULT_WINDOW_WEEKS);
  const [stateFilter, setStateFilter] = useState<"all" | "open" | "closed">("all");

  // Use the primary repo; fall back to any repo derived from board items.
  const effectiveRepo = project.repo || project.repos[0] || "";

  const { data, loading, error } = useGithubQuery<GhMilestone[]>(
    () => githubRequest<GhMilestone[]>(
      `repos/${effectiveRepo}/milestones?state=all&per_page=20&sort=due_on&direction=asc`,
    ),
    [effectiveRepo],
    !!effectiveRepo,
  );
  const milestones = Array.isArray(data) ? data : [];

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
    { k: "repo",          v: effectiveRepo.split("/")[1] || "—",    sub: effectiveRepo || "no repo", tone: "fg"      },
  ] as const;

  return (
    <>
      <ProjectsHeader project={project} />
      <section style={{ flex: 1, overflow: "auto", padding: "18px 24px" }}>
        <Box style={{ maxWidth: 1240, margin: "0 auto" }}>
          <QueryBanner error={error} style={{ marginBottom: 16 }} />

          {/* Stat cards */}
          <Grid cols={4} gap={10} style={{ marginBottom: 18 }}>
            {stats.map(({ k, v, sub, tone }) => (
              <StatCard key={k} k={k} v={v} sub={sub} tone={tone} />
            ))}
          </Grid>

          {/* Gantt */}
          <Card style={{ padding: "16px 20px" }}>
            <Row gap={10} wrap style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Milestones · weeks</h3>
              <Box as="span" className="hint">
                {loading ? "loading…"
                  : `${rows.length} shown${milestones.length !== rows.length ? ` of ${milestones.length}` : ""}`}
              </Box>
              <Spacer />
              {(() => {
                const chip = (active: boolean, label: string, onClick: () => void) => (
                  <Button
                    key={label}
                    onClick={onClick}
                    style={{
                      height: 22, fontSize: 10, padding: "0 8px",
                      background: active ? "var(--bg-elev2)" : "var(--bg-elev)",
                      borderColor: active ? "var(--accent-dim)" : "var(--border-soft)",
                      color: active ? "var(--accent)" : "var(--fg-muted)",
                    }}
                  >{label}</Button>
                );
                return (
                  <>
                    <Text mono size={9.5} tone="dim">state</Text>
                    <Row gap={4} align="stretch">
                      {(["all", "open", "closed"] as const).map(s => chip(stateFilter === s, s, () => setStateFilter(s)))}
                    </Row>
                    <Text mono size={9.5} tone="dim" style={{ marginLeft: 6 }}>window</Text>
                    <Row gap={4} align="stretch">
                      {WINDOW_PRESETS.map(p => chip(windowWeeks === p.weeks, p.label, () => setWindowWeeks(p.weeks)))}
                    </Row>
                  </>
                );
              })()}
            </Row>

            {!loading && rows.length === 0 && (
              <Text as="div" mono size={11} tone="dim" style={{ padding: "20px 0" }}>
                No milestones found for {effectiveRepo || "this project"}.
              </Text>
            )}

            {rows.length > 0 && (
              <>
                {/* Week header */}
                <Grid cols="230px 1fr" gap={14} style={{ marginBottom: 8 }}>
                  <Box />
                  <Box style={{ position: "relative", height: 24 }}>
                    {Array.from({ length: tickCount }, (_, i) => {
                      const week = i * tickInterval;
                      if (week > totalWeeks) return null;
                      const pct = (week / totalWeeks) * 100;
                      return (
                        <Box key={i} className="mono" style={{
                          position: "absolute", left: `${pct}%`,
                          top: 0, paddingLeft: 4, paddingTop: 4,
                          borderLeft: i === 0 ? "none" : "1px dashed var(--border-soft)",
                          fontSize: 10, color: "var(--fg-dim)",
                          whiteSpace: "nowrap",
                        }}>
                          {tickLabel(week, origin, tickInterval)}
                        </Box>
                      );
                    })}
                    {todayWeek < totalWeeks && (
                      <Box style={{
                        position: "absolute", top: 0, bottom: -300,
                        left: `${(todayWeek / totalWeeks) * 100}%`,
                        width: 0, borderLeft: "1.5px dashed var(--accent)", zIndex: 2,
                      }}>
                        <Box as="span" className="mono" style={{ position: "absolute", top: -2, left: 4, fontSize: 9.5, color: "var(--accent)" }}>today</Box>
                      </Box>
                    )}
                  </Box>
                </Grid>

                {/* Milestone rows */}
                <Stack gap={8}>
                  {rows.map(m => (
                    <Grid key={m.id} cols="230px 1fr" gap={14} align="center">
                      <Box>
                        <Row gap={6} align="baseline">
                          <Text mono size={11} tone="accent">M{m.id}</Text>
                          <Text as="span" size={12} style={{ fontFamily: "var(--sans)", color: "var(--fg)" }}>{m.title}</Text>
                        </Row>
                        <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 3 }}>
                          due {m.dueLabel}
                        </Text>
                      </Box>
                      <Box style={{ position: "relative", height: 32 }}>
                        {Array.from({ length: tickCount }, (_, i) => {
                          const week = i * tickInterval;
                          if (week > totalWeeks) return null;
                          return (
                            <Box key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${(week / totalWeeks) * 100}%`, width: 1, background: "var(--border-soft)" }} />
                          );
                        })}
                        <Row style={{
                          position: "absolute", top: 4, bottom: 4,
                          left: `${(m.startWeek / totalWeeks) * 100}%`,
                          width: `${(m.lengthWeeks / totalWeeks) * 100}%`,
                          borderRadius: 5, overflow: "hidden",
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
                            <Box style={{
                              position: "absolute", inset: 0, width: `${m.pct * 100}%`,
                              background: "color-mix(in oklch, var(--accent), transparent 40%)",
                            }} />
                          )}
                          <Box as="span" className="mono" style={{
                            position: "relative", padding: "0 10px",
                            fontSize: 10.5,
                            color: m.state === "backlog" ? "var(--fg-muted)" : "var(--fg)",
                            whiteSpace: "nowrap",
                          }}>
                            {m.lengthWeeks}w · {m.pct > 0 ? `${Math.round(m.pct * 100)}% done` : m.state}
                          </Box>
                        </Row>
                      </Box>
                    </Grid>
                  ))}
                </Stack>
              </>
            )}
          </Card>

          {/* Burn-down */}
          <Card style={{ padding: "16px 20px", marginTop: 14 }}>
            <Row gap={10} align="baseline" style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Issue progress</h3>
              <Box as="span" className="hint">{totalIssues} total · {totalClosed} closed · {totalOpen} remaining</Box>
            </Row>
            <BurnDown open={totalOpen} closed={totalClosed} />
          </Card>
        </Box>
      </section>
    </>
  );
}
