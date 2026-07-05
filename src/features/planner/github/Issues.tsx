import { useState, useMemo } from "react";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import type { ProjectV2Node } from "@/shared/lib/github/projectV2";
import {
  ISSUES_QUERY, parseIssues, deriveLabels, deriveMilestones, applyFilters,
  type FlatIssue, type Filters,
} from "./issues/issuesModel";
import { DetailPanel } from "./issues/DetailPanel";
import { FilterBar } from "./issues/FilterBar";
import { IssueRow } from "./issues/IssueRow";

// ── Issues screen ─────────────────────────────────────────────────────────────

/** Shimmer rows shaped like the issue list — the loading placeholder while the async board
 *  fetches, so the list LAYOUT stays present instead of a bare "Loading…" line (#2248). */
function SkeletonIssueRows({ rows = 8 }: { rows?: number }) {
  return (
    <Box aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Grid
          key={i}
          cols="44px 1fr 180px 80px 50px 48px"
          gap={10}
          align="center"
          style={{ padding: "11px 16px", borderBottom: "1px solid var(--border-soft)" }}
        >
          <Skeleton w={22} h={10} radius={5} />
          <Box style={{ minWidth: 0 }}>
            <Skeleton w={`${55 + (i % 3) * 12}%`} h={11} radius={5} style={{ marginBottom: 6 }} />
            <Skeleton w={90} h={9} radius={4} />
          </Box>
          <Skeleton w={120} h={10} radius={5} />
          <Skeleton w={28} h={10} radius={5} style={{ margin: "0 auto" }} />
          <Skeleton w={34} h={10} radius={5} style={{ marginLeft: "auto" }} />
          <Box />
        </Grid>
      ))}
    </Box>
  );
}

export function Issues() {
  const { project, data, loading, error } = useActiveProjectGithub<{ node: Record<string, unknown> }>(ISSUES_QUERY);

  const [selectedIssue, setSelectedIssue] = useState<FlatIssue | null>(null);
  const [filters, setFilters] = useState<Filters>({
    search: "", state: "open", label: "", milestone: "", sort: "newest",
  });

  const rawIssues = useMemo(() => parseIssues(data?.node as ProjectV2Node | undefined), [data]);

  const updateFilters = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

  const allLabels = useMemo(() => deriveLabels(rawIssues), [rawIssues]);
  const allMilestones = useMemo(() => deriveMilestones(rawIssues), [rawIssues]);

  const filtered = useMemo(() => applyFilters(rawIssues, filters), [rawIssues, filters]);

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
          {loading && rawIssues.length === 0 && <SkeletonIssueRows />}

          <QueryBanner error={error} style={{ margin: 12 }} />

          {!loading && !error && filtered.length === 0 && rawIssues.length > 0 && (
            <EmptyState
              size="sm"
              iconVariant="dashed"
              icon="⊘"
              title="No matches"
              description="No issues match the current filters."
              style={{ padding: "40px 12px" }}
            />
          )}

          {!loading && !error && rawIssues.length === 0 && (
            <EmptyState
              size="sm"
              iconVariant="dashed"
              icon="◔"
              title="No issues"
              description="No issues found in this project."
              style={{ padding: "40px 12px" }}
            />
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
