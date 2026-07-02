import { useState, useMemo } from "react";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { timeAgoShort } from "@/shared/lib/core/format";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Chip } from "@/shared/ui/data/Chip";
import { parseProjectV2Items, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";
import type { GhLabel } from "@/shared/lib/github/types";

// ── Types ─────────────────────────────────────────────────────────────────────

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
      <Row align="start" gap={10} style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
      }}>
        <Box style={{ flex: 1 }}>
          <Row gap={8} align="baseline">
            <Text mono size={11} tone="dim">#{issue.number}</Text>
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--fg)" }}>{issue.title}</h3>
          </Row>
          <Row gap={6} wrap style={{ marginTop: 8 }}>
            <Chip tone={issue.state === "OPEN" ? "accent" : "neutral"} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </Chip>
            {issue.statusName && (
              <Text mono size={10} tone="dim">
                {issue.statusName}
              </Text>
            )}
            {issue.milestone && (
              <Text mono size={10} tone="accent">{issue.milestone}</Text>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </Row>
        </Box>
        <Button variant="ghost" style={{ height: 26 }}>open on github →</Button>
        <IconButton aria-label="close" onClick={onClose} />
      </Row>

      <Box style={{ flex: 1, overflow: "auto" }}>
        {/* Body */}
        <Box pad={[16, 20]} style={{ borderBottom: "1px solid var(--border-soft)" }}>
          <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</Text>
          {issue.body ? (
            <Text as="div" size={12.5} tone="muted" style={{ lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {issue.body.slice(0, 800)}{issue.body.length > 800 ? "…" : ""}
            </Text>
          ) : (
            <Text as="div" mono size={11} tone="dim" style={{ fontStyle: "italic" }}>No description.</Text>
          )}
        </Box>

        {/* Meta */}
        <Stack gap={10} style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          {issue.assignees.length > 0 && (
            <Box>
              <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>assignees</Text>
              <Row gap={8} wrap align="stretch">
                {issue.assignees.map(a => (
                  <Row key={a.login} gap={6}>
                    <Avatar login={a.login} size={18} palette bordered fontScale={0.56} />
                    <Text mono size={11} tone="muted">@{a.login}</Text>
                  </Row>
                ))}
              </Row>
            </Box>
          )}
          <Row className="mono" gap={24} align="stretch" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {issue.comments > 0 && <Text as="span">💬 {issue.comments} comment{issue.comments !== 1 ? "s" : ""}</Text>}
            <Text as="span">updated {timeAgoShort(issue.updatedAt)} ago</Text>
          </Row>
        </Stack>

        {/* Claude breakdown */}
        <Box pad={[14, 20]} bg="var(--bg-elev)">
          <Row gap={8} style={{ marginBottom: 10 }}>
            <Row className="mono" justify="center" style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontWeight: 700, fontSize: 11,
            }}>C</Row>
            <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>Claude</Text>
            <Spacer />
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ break down</Button>
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>open in pane</Button>
          </Row>
          <textarea
            className="input mono"
            placeholder="ask claude about this issue…"
            style={{ width: "100%", height: 54, padding: "8px 10px", fontSize: 11, boxSizing: "border-box" }}
          />
        </Box>
      </Box>
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
    <Row gap={8} wrap style={{
      padding: "10px 16px", borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
    }}>
      <input
        className="input"
        placeholder="⌕ filter issues…"
        value={filters.search}
        onChange={e => onChange({ search: e.target.value })}
        style={{ height: 26, width: 220, fontSize: 11 }}
      />

      <Row gap={1} align="stretch" style={{ borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
        {stateOpts.map(({ k, label }) => (
          <button
            key={k}
            onClick={() => onChange({ state: k })}
            className="mono"
            style={{
              height: 26, padding: "0 10px",
              fontSize: 10.5,
              background: filters.state === k ? "var(--bg-elev2)" : "var(--bg-elev)",
              border: "none", borderRight: k !== "closed" ? "1px solid var(--border-soft)" : "none",
              color: filters.state === k ? "var(--fg)" : "var(--fg-muted)",
              cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </Row>

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

      <Spacer />

      <Text mono size={10.5} tone="dim">
        {shown === total ? `${total} issues` : `${shown} of ${total}`}
      </Text>

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
    </Row>
  );
}

// ── Issue row ─────────────────────────────────────────────────────────────────

function IssueRow({ issue, selected, onClick }: { issue: FlatIssue; selected: boolean; onClick: () => void }) {
  return (
    <Grid
      cols="44px 1fr 180px 80px 50px 48px"
      gap={10}
      align="center"
      onClick={onClick}
      style={{
        padding: "9px 16px",
        background: selected ? "color-mix(in oklch, var(--accent), transparent 93%)" : "transparent",
        borderBottom: "1px solid var(--border-soft)",
        cursor: "pointer",
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elev)"; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    >
      {/* Number + state */}
      <Row gap={5}>
        <StatusDot
          size={8}
          color={issue.state === "OPEN" ? "var(--success)" : "var(--fg-dim)"}
          title={issue.state === "OPEN" ? "open" : "closed"}
        />
        <Text mono size={10.5} tone="dim">
          {issue.number}
        </Text>
      </Row>

      {/* Title + labels */}
      <Box style={{ minWidth: 0 }}>
        <Text as="div" size={12.5} style={{
          color: "var(--fg)", marginBottom: 4,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{issue.title}</Text>
        <Row gap={4} wrap align="stretch">
          {issue.statusName && (
            <Box as="span" className="mono" pad={[1, 5]} bg="var(--bg-elev2)" border="soft" radius={3} style={{
              fontSize: 9, color: "var(--fg-dim)",
            }}>{issue.statusName}</Box>
          )}
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </Row>
      </Box>

      {/* Assignees + milestone */}
      <Stack gap={4} style={{ minWidth: 0 }}>
        {issue.assignees.length > 0 && (
          <Row align="stretch">
            {issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} size={16} ml={i === 0 ? 0 : -5} palette bordered fontScale={0.56} />)}
            <Text mono size={10} tone="muted" style={{
              marginLeft: 6,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {issue.assignees.map(a => a.login).join(", ")}
            </Text>
          </Row>
        )}
        {issue.milestone && (
          <Text mono size={10} tone="accent" style={{ whiteSpace: "nowrap" }}>
            ◈ {issue.milestone}
          </Text>
        )}
      </Stack>

      {/* Comments */}
      <Text as="div" mono size={10.5} tone="dim" style={{ textAlign: "center" }}>
        {issue.comments > 0 ? `💬 ${issue.comments}` : "—"}
      </Text>

      {/* Updated */}
      <Text as="div" mono size={10} tone="dim" style={{ textAlign: "right" }}>
        {timeAgoShort(issue.updatedAt)}
      </Text>

      {/* Open in pane */}
      <Row justify="end" align="stretch">
        <Button
          variant="ghost"
          style={{ height: 22, padding: "0 7px", fontSize: 9.5 }}
          onClick={e => { e.stopPropagation(); }}
        >⊕</Button>
      </Row>
    </Grid>
  );
}

// ── Issues screen ─────────────────────────────────────────────────────────────

export function Issues() {
  const { project, data, loading, error } = useActiveProjectGithub<{ node: Record<string, unknown> }>(ISSUES_QUERY);

  const [selectedIssue, setSelectedIssue] = useState<FlatIssue | null>(null);
  const [filters, setFilters] = useState<Filters>({
    search: "", state: "open", label: "", milestone: "", sort: "newest",
  });

  const rawIssues = useMemo<FlatIssue[]>(() => parseProjectV2Items<{
    number: number; title: string; body: string;
    state: "OPEN" | "CLOSED"; updatedAt: string;
    labels: { nodes: GhLabel[] };
    assignees: { nodes: GhUser[] };
    comments: { totalCount: number };
    milestone?: { title: string } | null;
  }, FlatIssue>(data?.node as ProjectV2Node | undefined, (c, item) => ({
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
    statusName: statusFieldValue(item)?.name ?? null,
  })), [data]);

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

  const panelOpen = selectedIssue !== null;

  return (
    <>
      <ProjectsHeader project={project} />
      <Stack style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <FilterBar
          filters={filters}
          onChange={updateFilters}
          labels={allLabels}
          milestones={allMilestones}
          total={rawIssues.length}
          shown={filtered.length}
        />

        {/* Column header */}
        <Grid
          cols="44px 1fr 180px 80px 50px 48px"
          gap={10}
          className="mono"
          style={{
            padding: "6px 16px",
            borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-panel)",
            fontSize: 10, color: "var(--fg-dim)",
            textTransform: "uppercase", letterSpacing: ".05em",
          }}
        >
          <Text as="div">#</Text>
          <Text as="div">title</Text>
          <Text as="div">assignee · milestone</Text>
          <Text as="div" style={{ textAlign: "center" }}>comments</Text>
          <Text as="div" style={{ textAlign: "right" }}>updated</Text>
          <Box />
        </Grid>

        <Box bg="var(--bg-canvas)" style={{ flex: 1, overflow: "auto", position: "relative" }}>
          {loading && rawIssues.length === 0 && (
            <Text as="div" mono size={12} tone="dim" style={{ padding: "40px 0", textAlign: "center" }}>
              Loading issues…
            </Text>
          )}

          <QueryBanner error={error} style={{ margin: 12 }} />

          {!loading && !error && filtered.length === 0 && rawIssues.length > 0 && (
            <Text as="div" mono size={12} tone="dim" style={{ padding: "40px 0", textAlign: "center" }}>
              No issues match the current filters.
            </Text>
          )}

          {!loading && !error && rawIssues.length === 0 && !error && (
            <Text as="div" mono size={12} tone="dim" style={{ padding: "40px 0", textAlign: "center" }}>
              No issues found in this project.
            </Text>
          )}

          <Box style={{
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
          </Box>

          {panelOpen && selectedIssue && (
            <DetailPanel issue={selectedIssue} onClose={() => setSelectedIssue(null)} />
          )}
        </Box>
      </Stack>
    </>
  );
}
