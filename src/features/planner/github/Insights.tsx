import { useMemo } from "react";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { avatarColor, GH_OPTION_COLORS } from "@/shared/lib/github/colors";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Bars, HBars, StatCard } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";

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

// ── Insights screen ───────────────────────────────────────────────────────────

export function Insights() {
  const { project, data, loading, error } = useActiveProjectGithub<{ node: Record<string, unknown> }>(INSIGHTS_QUERY);

  const { issues, statusOptions } = useMemo(() => {
    const node = data?.node as ProjectV2Node | undefined;
    const list = parseProjectV2Items<{
      number: number; state: "OPEN" | "CLOSED";
      createdAt: string; updatedAt: string;
      labels: { nodes: Array<{ name: string; color: string }> };
      assignees: { nodes: Array<{ login: string }> };
      comments: { totalCount: number };
      milestone?: { title: string } | null;
    }, InsightIssue>(node, (c, item) => ({
      id: item.id,
      number: c.number,
      state: c.state,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      labels: c.labels.nodes,
      assignees: c.assignees.nodes,
      comments: c.comments.totalCount,
      milestone: c.milestone?.title ?? null,
      statusName: statusFieldValue(item)?.name ?? null,
    }));
    return { issues: list, statusOptions: parseProjectV2Fields(node) };
  }, [data]);

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

  const isLoading = loading && issues.length === 0;

  return (
    <>
      <ProjectsHeader project={project} />
      <section style={{ flex: 1, overflow: "auto", padding: "18px 24px" }}>
        <Box style={{ maxWidth: 1240, margin: "0 auto" }}>

          <QueryBanner error={error} style={{ marginBottom: 16 }} />

          {isLoading && (
            <Text as="div" mono size={12} tone="dim" style={{ padding: "40px 0", textAlign: "center" }}>
              Loading insights…
            </Text>
          )}

          {!isLoading && (
            <>
              {/* Stat cards */}
              <Grid cols={4} gap={10} style={{ marginBottom: 18 }}>
                <StatCard k="total items"   v={String(total)}    sub={`${open} open · ${closed} closed`}         tone="fg"      />
                <StatCard k="completion"    v={`${completionPct}%`} sub={`${closed} of ${total} closed`}          tone="success" />
                <StatCard k="velocity"      v={`${velocity}/wk`} sub="issues closed · last 4 weeks"               tone="info"    />
                <StatCard k="open issues"   v={String(open)}     sub={`${total > 0 ? Math.round((open / total) * 100) : 0}% remaining`} tone="accent" />
              </Grid>

              {/* Middle row: status + assignees */}
              <Grid cols="1.4fr 1fr" gap={14} style={{ marginBottom: 14 }}>
                {/* Status distribution */}
                <Card style={{ padding: "16px 20px" }}>
                  <Row gap={10} align="baseline" style={{ marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Status distribution</h3>
                    <Box as="span" className="hint">{total} items</Box>
                  </Row>
                  {statusDist.length === 0 ? (
                    <Text as="div" mono size={11} tone="dim">No status field found.</Text>
                  ) : (
                    <HBars
                      max={maxStatusCount}
                      rows={statusDist.map(s => ({ label: s.name, value: s.count, color: s.color }))}
                    />
                  )}
                </Card>

                {/* Assignee workload */}
                <Card style={{ padding: "16px 20px" }}>
                  <Row gap={10} align="baseline" style={{ marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Assignee workload</h3>
                    <Box as="span" className="hint">open issues</Box>
                  </Row>
                  {assigneeDist.length === 0 ? (
                    <Text as="div" mono size={11} tone="dim">No open issues.</Text>
                  ) : (
                    <Stack gap={8}>
                      {assigneeDist.map(a => (
                        <Grid key={a.login} cols="18px 112px 1fr 32px" gap={8} align="center">
                          {a.login === "(unassigned)" ? (
                            <Box as="span" className="mono" style={{
                              width: 16, height: 16, borderRadius: "50%",
                              border: "1px dashed var(--border)", color: "var(--fg-dim)",
                              fontSize: 9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>?</Box>
                          ) : (
                            <Box as="span" className="mono" bg={avatarColor(a.login)} style={{
                              width: 16, height: 16, borderRadius: "50%", color: "#1a120a",
                              fontWeight: 700, fontSize: 9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>{a.login[0]?.toUpperCase()}</Box>
                          )}
                          <Text as="div" mono size={10.5} tone="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {a.login}
                          </Text>
                          <Box bg="var(--bg-elev2)" radius={3} style={{ height: 10, overflow: "hidden" }}>
                            <Box bg={avatarColor(a.login === "(unassigned)" ? "?" : a.login)} radius={3} style={{
                              height: "100%",
                              width: `${(a.count / maxAssigneeCount) * 100}%`,
                            }} />
                          </Box>
                          <Text as="div" mono size={10} tone="dim" style={{ textAlign: "right" }}>{a.count}</Text>
                        </Grid>
                      ))}
                    </Stack>
                  )}
                </Card>
              </Grid>

              {/* Weekly activity */}
              <Card style={{ padding: "16px 20px", marginBottom: 14 }}>
                <Row gap={10} align="baseline" style={{ marginBottom: 14 }}>
                  <h3 style={{ margin: 0 }}>Weekly activity</h3>
                  <Box as="span" className="hint">last 8 weeks</Box>
                  <Spacer />
                  <Row className="mono" gap={14} align="stretch" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                    <Box as="span" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <Box as="span" bg="color-mix(in oklch, var(--info), transparent 40%)" radius={2} style={{ width: 10, height: 10, display: "inline-block" }} />
                      opened
                    </Box>
                    <Box as="span" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <Box as="span" bg="color-mix(in oklch, var(--success), transparent 40%)" radius={2} style={{ width: 10, height: 10, display: "inline-block" }} />
                      closed
                    </Box>
                  </Row>
                </Row>
                <Bars
                  labels={weeklyActivity.map(w => w.label)}
                  height={100}
                  groups={[
                    { name: "opened", color: "color-mix(in oklch, var(--info), transparent 40%)",    data: weeklyActivity.map(w => w.opened) },
                    { name: "closed", color: "color-mix(in oklch, var(--success), transparent 40%)", data: weeklyActivity.map(w => w.closed) },
                  ]}
                />
              </Card>

              {/* Label distribution */}
              {labelDist.length > 0 && (
                <Card style={{ padding: "16px 20px" }}>
                  <Row gap={10} align="baseline" style={{ marginBottom: 14 }}>
                    <h3 style={{ margin: 0 }}>Label frequency</h3>
                    <Box as="span" className="hint">top {labelDist.length}</Box>
                  </Row>
                  <Grid cols={2} gap={32}>
                    {[labelDist.slice(0, Math.ceil(labelDist.length / 2)), labelDist.slice(Math.ceil(labelDist.length / 2))].map((half, col) => (
                      <HBars
                        key={col}
                        max={maxLabelCount}
                        rows={half.map(l => ({ label: l.name, value: l.count, color: l.color }))}
                      />
                    ))}
                  </Grid>
                </Card>
              )}
            </>
          )}

        </Box>
      </section>
    </>
  );
}
