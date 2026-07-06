import { useState, type Dispatch, type SetStateAction } from "react";
import { useAppStore } from "@/store";
import { timeAgoMs } from "@/shared/lib/core/format";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import type { DraftRow, LocalProjectLite } from "./drafts";
import type { LocalPublishedRow } from "./localPublished";
import { useReopenProject } from "./ReopenProjectModal";
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
  /** Re-fetch the published boards; `force: true` (the manual ↻ sync) bypasses the TTL cache (#2447). */
  fetchProjects: (opts?: { force?: boolean }) => void;
  setProjects: Dispatch<SetStateAction<GhProject[]>>;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  reopenDraft: (d: { key: string; title: string; pitch: string }) => void;
  setDraftDeleteTarget: (d: DraftRow | null) => void;
  /** On-disk local hubs (`list_local_projects`) — the reopen flow derives each board project's hub
   *  from its name (#2409) and offers these as link candidates on a mismatch. */
  localProjects: LocalProjectLite[];
  /** Re-scan the on-disk hubs (after a link moved one). */
  refreshLocalProjects: () => void;
  /** Published hubs rendered from the LOCAL inventory (#2445) — the offline published set; a fetched
   *  GitHub board matching a hub overlays it (the hub drops out of this list, the board row renders). */
  localPublished: LocalPublishedRow[];
  /** When the PERSISTED last-known board state (#2446) is what's rendering (no live fetch yet this
   *  mount), the time that state was fetched (epoch ms) — drives the "last synced 2h ago" hint.
   *  `null` when the live fetch landed or there is no persisted overlay. */
  staleFetchedAt: number | null;
}

/** The published-projects column — the page header (title · summary · sync/new · new-project form ·
 *  search+sort), the Drafts chips, the active/shipped project groups, and the published-project
 *  Keep-vs-Delete modal. The composer owns the project scan + shared search/sort + the shared
 *  draft-delete flow; this component owns the new-project form and the published-delete flow. */
export function PublishedProjects({
  visibleProjects, grouped, fDrafts, fleetByProject, loading, error, lastSync, draftError,
  query, setQuery, sort, setSort, totalSummary, grandTotal, publishedCount,
  fetchProjects, setProjects, menuOpenId, setMenuOpenId, reopenDraft, setDraftDeleteTarget,
  localProjects, refreshLocalProjects, localPublished, staleFetchedAt,
}: PublishedProjectsProps) {
  const {
    setWorkspace, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard,
    setPlanningContext, setPlanningTitle, setPlanningSession, githubToken,
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

  // Enter the planning session for a board project under its settled key (#2409): the key is
  // DERIVED from the name (`projectSlug`), never looked up through a node-id alias — the seam that
  // fed recovery the wrong hub ("video game"). The node id stays in activeProjectId for API calls.
  function openPlanning(p: GhProject, key: string) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
    // Reflect the opened project's title in the planning session so the fleet/triage tab is named after
    // THIS project — not a stale draft title left in `planningTitle` from a prior session. The tab name
    // resolves via `deriveProjectTitle` as `planningTitle || activeProjectName`, so a leftover draft
    // title ("ok") would otherwise win and mislabel a published project's triage/fleet tab (#1988).
    setPlanningTitle(p.title);
    setPlanningContext(p.shortDescription ?? p.title, repo);
    setPlanningSession(key);
    setProjectsView("planning");
  }

  // Derivation first, modal on a mismatch (#2409): a hub at `projectSlug(title)` opens in place;
  // otherwise the reopen-mismatch modal offers a one-time link (real on-disk move) or a fresh start.
  const reopen = useReopenProject<GhProject>(openPlanning, refreshLocalProjects);
  function handleEditPlan(p: GhProject) {
    reopen.begin(p, p.title, localProjects);
  }

  const publishedAndDrafts = publishedCount + fDrafts.length;
  // The main (projects) column is empty when there are no projects or drafts; the
  // blueprints rail shows its own empty state independently. Local published hubs count as
  // content (#2445) — logged out they ARE the published column.
  const projectsEmpty = publishedCount === 0 && fDrafts.length === 0 && localPublished.length === 0;
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
          localProjects={localProjects}
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
          openExistingPublished={handleEditPlan}
          openExistingLocal={(lp) => reopenDraft({ key: lp.key, title: lp.title, pitch: "" })}
        />

        {/* scroll area: errors · drafts chips · active/shipped groups · empty */}
        <Box style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 28px 28px" }}>
          {error && (
            <InlineError pad={[12, 16]} radius={6} style={{ marginBottom: 16 }}>
              {error.includes("read:project")
                ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
                : error}
            </InlineError>
          )}

          {loading && visibleProjects.length === 0 && (
            <Text as="div" mono size={12} tone="dim" style={{ textAlign: "center", padding: "40px 0" }}>
              Loading projects…
            </Text>
          )}

          {draftError && (
            <InlineError radius="md" borderFade={60} style={{ marginBottom: 12 }}>{draftError}</InlineError>
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

          {/* Staleness hint (#2445/#2446): pre-sync, the column renders the local copies and/or the
              persisted last-known board state. With persisted data the hint carries its age ("last
              synced 2h ago"); with none — and logged out — it keeps the #2445 "not synced" wording. */}
          {staleFetchedAt != null ? (
            <Text className="hint" as="div" mono size={10} style={{ margin: "0 0 7px", paddingLeft: 2 }}>
              last synced {timeAgoMs(staleFetchedAt)}
            </Text>
          ) : (!githubToken && localPublished.length > 0 && (
            <Text className="hint" as="div" mono size={10} style={{ margin: "0 0 7px", paddingLeft: 2 }}>
              not synced — GitHub is disconnected, showing the local copies
            </Text>
          ))}

          {/* published hubs from the LOCAL inventory (#2445) — the offline published set. Rendered
              from `.published` + `.title` with the hub key as the identity; a fetched GitHub board
              (live, or the persisted #2446 overlay) matching a hub OVERLAYS it (the hub leaves this
              list, the full ProjectRow renders below). */}
          {localPublished.length > 0 && (
            <Box style={{ marginBottom: 22 }}>
              <GroupHeader label="published" count={localPublished.length} dot="var(--success)" />
              <Box border="soft" radius="lg" style={{ overflow: "hidden" }}>
                {localPublished.map((lp, i) => (
                  <Row
                    key={lp.key}
                    gap={10}
                    align="center"
                    onClick={() => reopenDraft({ key: lp.key, title: lp.title, pitch: "" })}
                    title={`local copy · ${lp.key}`}
                    style={{ padding: "10px 14px", cursor: "pointer", borderTop: i ? "1px solid var(--border-soft)" : "none" }}
                  >
                    <Box as="span" bg="var(--success)" radius={99} style={{ width: 5, height: 5, flexShrink: 0 }} />
                    <Text as="span" mono size={12} style={{ color: "var(--fg)", whiteSpace: "nowrap" }}>{lp.title}</Text>
                    <Text as="span" mono size={10} tone="dim" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lp.key}</Text>
                    <Box style={{ flex: 1 }} />
                    <Text as="span" mono size={10} tone="dim" style={{ whiteSpace: "nowrap" }}>{timeAgoMs(lp.updatedAt)}</Text>
                  </Row>
                ))}
              </Box>
            </Box>
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

      {/* Reopen-mismatch modal (#2409): link an existing local hub onto the name key, or start fresh. */}
      {reopen.modal}

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
