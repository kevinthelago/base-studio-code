import { useState, type Dispatch, type SetStateAction } from "react";
import { useAppStore } from "@/store";
import { timeAgoMs } from "@/shared/lib/core/format";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { DraftRow } from "./drafts";
import { STATUS_META, type GhProject, type ProjStatus } from "./published/publishedModel";
import { ProjectRow } from "./published/ProjectRow";
import { GroupHeader } from "./published/GroupHeader";
import { PublishedHeader } from "./published/PublishedHeader";
import { DeleteProjectModal } from "./published/DeleteProjectModal";

// Public API preserved for existing importers/tests (ProjectsList re-exports several of these).
export { ProjectRow } from "./published/ProjectRow";
export { projStatus, PROJECTS_QUERY } from "./published/publishedModel";
export type { GhProject, ProjStatus } from "./published/publishedModel";

interface PublishedProjectsProps {
  visibleProjects: GhProject[];
  grouped: Record<ProjStatus, GhProject[]>;
  fDrafts: DraftRow[];
  fleetByProject: Record<string, { running: number; paused: number }>;
  loading: boolean;
  error: string | null;
  lastSync: Date | null;
  draftError: string | null;
  query: string;
  setQuery: (s: string) => void;
  sort: "recency" | "name";
  setSort: (s: "recency" | "name") => void;
  /** Cross-section summary line ("N published · M drafts · K blueprints · R repos"). */
  totalSummary: string;
  /** Total matches across all three lists (drives the "N matches" pill while searching). */
  grandTotal: number;
  /** Published count (active + shipped), for the header badge. */
  publishedCount: number;
  fetchProjects: () => void;
  setProjects: Dispatch<SetStateAction<GhProject[]>>;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  reopenDraft: (d: { key: string; title: string; pitch: string }) => void;
  setDraftDeleteTarget: (d: DraftRow | null) => void;
}

/** The published-projects column — the page header (title · summary · sync/new · new-project form ·
 *  search+sort), the Drafts chips, the active/shipped project groups, and the published-project
 *  Keep-vs-Delete modal. The composer owns the project scan + shared search/sort + the shared
 *  draft-delete flow; this component owns the new-project form and the published-delete flow. */
export function PublishedProjects({
  visibleProjects, grouped, fDrafts, fleetByProject, loading, error, lastSync, draftError,
  query, setQuery, sort, setSort, totalSummary, grandTotal, publishedCount,
  fetchProjects, setProjects, menuOpenId, setMenuOpenId, reopenDraft, setDraftDeleteTarget,
}: PublishedProjectsProps) {
  const {
    setWorkspace, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard,
    setPlanningContext, setPlanningTitle, setPlanningSession, projectKeyAlias,
  } = useAppStore();
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);

  // The GitHub Projects v2 board now lives on the GitHub page (#498).
  function handleOpenGithubBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    setGithubTab("projects"); // so "← portfolio" returns to the Projects tab
    setWorkspace("github");
    openGithubBoard("board");
  }

  function handleEditPlan(p: GhProject) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
    // Reflect the opened project's title in the planning session so the fleet/triage tab is named after
    // THIS project — not a stale draft title left in `planningTitle` from a prior session. The tab name
    // resolves via `deriveProjectTitle` as `planningTitle || activeProjectName`, so a leftover draft
    // title ("ok") would otherwise win and mislabel a published project's triage/fleet tab (#1988).
    setPlanningTitle(p.title);
    setPlanningContext(p.shortDescription ?? p.title, repo);
    // Resolve the session key through the node-id alias set at publish (#1741): a project
    // created with a stable id lives under that id on disk, so reopening it from the board must
    // key the session to `projectKeyAlias[p.id]`, not the (display-only, freely-renamed) title.
    // Grandfathered/title-keyed projects have no such alias (or it maps back to the title), so
    // the fallback preserves their existing behavior exactly. The node id stays in
    // activeProjectId for API calls only.
    setPlanningSession(projectKeyAlias[p.id] ?? p.title);
    setProjectsView("planning");
  }

  const publishedAndDrafts = publishedCount + fDrafts.length;
  // The main (projects) column is empty when there are no projects or drafts; the
  // blueprints rail shows its own empty state independently.
  const projectsEmpty = publishedCount === 0 && fDrafts.length === 0;
  const q = query.trim().toLowerCase();

  return (
    <>
      {/* ░░ MAIN — projects ░░
          A min-width floor (not 0) so the projects column stays usable in a narrow / half window:
          the shrinkable blueprints rail (below) gives back space first, instead of this column
          collapsing to nothing and the fixed-width rail overflowing the clipped section. */}
      <Stack style={{ flex: "1 1 0", minWidth: 320 }}>
        <PublishedHeader
          visibleProjects={visibleProjects}
          publishedAndDrafts={publishedAndDrafts}
          totalSummary={totalSummary}
          lastSync={lastSync}
          loading={loading}
          fetchProjects={fetchProjects}
          query={query}
          setQuery={setQuery}
          sort={sort}
          setSort={setSort}
          grandTotal={grandTotal}
        />

        {/* scroll area: errors · drafts chips · active/shipped groups · empty */}
        <Box style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 28px 28px" }}>
          {error && (
            <Box className="mono" pad={[12, 16]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius={6} style={{ marginBottom: 16,
              border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
              fontSize: 11, color: "var(--danger)",
            }}>
              {error.includes("read:project")
                ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
                : error}
            </Box>
          )}

          {loading && visibleProjects.length === 0 && (
            <Text as="div" mono size={12} tone="dim" style={{ textAlign: "center", padding: "40px 0" }}>
              Loading projects…
            </Text>
          )}

          {draftError && (
            <Box className="mono" pad={[8, 12]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius="md" style={{ marginBottom: 12, fontSize: 11,
              color: "var(--danger)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)",
            }}>{draftError}</Box>
          )}

          {/* drafts — compact chips (click = resume · ✕ = delete) */}
          {fDrafts.length > 0 && (
            <Row gap={9} wrap style={{ marginBottom: 20 }}>
              <Text mono size={9.5} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".08em", whiteSpace: "nowrap" }}>
                {fDrafts.length} draft{fDrafts.length !== 1 ? "s" : ""}
              </Text>
              {fDrafts.map(d => (
                <Box as="span"
                  key={d.key}
                  onClick={() => reopenDraft(d)}
                  title={d.pitch || undefined}
                  className="mono"
                  pad={[5, 12]} bg="var(--bg-elev)" border="soft" radius={7} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg)", cursor: "pointer" }}
                >
                  <Box as="span" bg="var(--accent)" radius={99} style={{ width: 5, height: 5, flexShrink: 0 }} />
                  {d.title}
                  <Text as="span" tone="dim">{timeAgoMs(d.sort)}</Text>
                  <Box as="span"
                    onClick={e => { e.stopPropagation(); setDraftDeleteTarget(d); }}
                    title="delete draft"
                    style={{ color: "var(--fg-dim)", cursor: "pointer", paddingLeft: 2 }}
                  >✕</Box>
                </Box>
              ))}
            </Row>
          )}

          {/* published projects, grouped by lifecycle */}
          {(["active", "shipped"] as ProjStatus[]).map(status => {
            const items = grouped[status];
            if (items.length === 0) return null;
            return (
              <Box key={status} style={{ marginBottom: 22 }}>
                <GroupHeader label={STATUS_META[status].label} count={items.length} dot={STATUS_META[status].dot} />
                <Box border="soft" radius="lg" style={{ overflow: "visible", opacity: status === "shipped" ? 0.82 : 1 }}>
                  {items.map((p, i) => (
                    <Box key={p.id} style={{ borderTop: i ? "1px solid var(--border-soft)" : "none" }}>
                      <ProjectRow
                        p={p}
                        running={fleetByProject[p.id]?.running ?? 0}
                        paused={fleetByProject[p.id]?.paused ?? 0}
                        onPlan={handleEditPlan}
                        onBoard={handleOpenGithubBoard}
                        onDelete={setDeleteTarget}
                        menuOpenId={menuOpenId}
                        setMenuOpenId={setMenuOpenId}
                      />
                    </Box>
                  ))}
                </Box>
              </Box>
            );
          })}

          {/* empty (main column only — the rail has its own) */}
          {!loading && projectsEmpty && (
            q ? (
              <Text as="div" mono size={12} tone="dim" style={{ textAlign: "center", padding: "48px 0" }}>
                No projects match “{query}”.
              </Text>
            ) : !error && (
              <Text as="div" mono size={12} tone="dim" style={{ textAlign: "center", padding: "48px 0" }}>
                Nothing here yet. Start a plan with <b style={{ color: "var(--fg-muted)" }}>+ New project</b>.
              </Text>
            )
          )}
        </Box>
      </Stack>

      {deleteTarget && (
        <DeleteProjectModal
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          setProjects={setProjects}
        />
      )}
    </>
  );
}
