import { useState, useMemo } from "react";
import { ProjectsHeader } from "../list/ProjectsHeader";
import { useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import type { ProjectV2Node } from "@/features/github/lib/projectV2";
import {
  ISSUES_QUERY, parseIssues, deriveLabels, deriveMilestones, applyFilters,
  type FlatIssue, type Filters,
} from "./issues/issuesModel";
import { DetailPanel } from "./issues/DetailPanel";
import { FilterBar } from "./issues/FilterBar";
import { IssueRow } from "./issues/IssueRow";

// ── Issues screen ─────────────────────────────────────────────────────────────

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
