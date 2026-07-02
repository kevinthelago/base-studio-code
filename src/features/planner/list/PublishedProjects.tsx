import { useState, useRef, type Dispatch, type SetStateAction } from "react";
import { Chip, tagTone } from "@/shared/ui/data/Chip";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { ExternalLink, MoreHorizontal, Trash2, Search } from "lucide-react";
import { useAppStore } from "@/store";
import { mintProjectId, findByTitle } from "@/shared/lib/core/projectPaths";
import { timeAgo, timeAgoMs } from "@/shared/lib/core/format";
import { overlayDismiss } from "@/shared/hooks/useModalDismiss";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { DEFAULT_BLUEPRINT_ID } from "../stages/blueprints";
import type { DraftRow } from "./drafts";

// A published project's lifecycle, derived from GitHub state: open ⇒ active, closed ⇒ shipped.
// (Local, not-yet-on-GitHub work lives in the separate Drafts section.)
export type ProjStatus = "active" | "shipped";
const STATUS_META: Record<ProjStatus, { label: string; cls: string; dot: string }> = {
  active:   { label: "active",   cls: "green", dot: "var(--success)" },
  shipped:  { label: "shipped",  cls: "",      dot: "var(--fg-dim)" },
};
export function projStatus(p: { closed: boolean }): ProjStatus {
  return p.closed ? "shipped" : "active";
}

/** Live "N agents running · M paused" pill for a project (matched by repo). */
function FleetPill({ running, paused }: { running: number; paused: number }) {
  if (running === 0 && paused === 0) return null;
  return (
    <Box as="span" className="mono" pad={[2, 9]} bg="color-mix(in oklch, var(--success), transparent 88%)" radius={99} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 9.5, color: "var(--success)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 70%)",
    }}>
      <Box as="span" bg="var(--success)" radius={99} style={{ width: 6, height: 6, animation: "pulse 1.4s ease-in-out infinite" }} />
      <Box as="span">{running} agent{running !== 1 ? "s" : ""} running</Box>
      {paused > 0 && <Text as="span" tone="dim">· {paused} paused</Text>}
    </Box>
  );
}

/** Lifecycle sub-group header within the Projects section (Active · Drafting · Shipped). */
function GroupHeader({ label, count, dot }: { label: string; count: number; dot: string }) {
  return (
    <Row gap={8} style={{ margin: "0 0 7px", paddingLeft: 2 }}>
      <Box as="span" bg={dot} radius={99} style={{ width: 6, height: 6}} />
      <Text mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</Text>
      <Box as="span" className="mono" pad={[0, 5]} bg="var(--bg-elev2)" border="soft" radius={8} style={{ fontSize: 9, color: "var(--fg-muted)"}}>{count}</Box>
    </Row>
  );
}

/** Milestone-progress bar: fraction of the project's items that are closed. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <Box as="span" title={`${Math.round(pct * 100)}% of items closed`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Box as="span" bg="var(--bg-elev2)" radius={99} style={{ width: 56, height: 4, overflow: "hidden", display: "inline-block" }}>
        <Box as="span" bg={pct >= 1 ? "var(--success)" : "var(--accent)"} style={{ display: "block", height: "100%", width: `${pct * 100}%`}} />
      </Box>
      <Text as="span" mono size={9.5} tone="dim">{Math.round(pct * 100)}%</Text>
    </Box>
  );
}

interface GhProjectItem { content: { __typename?: string; state?: string } | null }
export interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number; nodes: GhProjectItem[] };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

// Open count + closed fraction from the fetched item states (capped at 100 items;
// totalCount is the true item count, used for the headline number).
function projectProgress(p: GhProject): { open: number; pct: number } {
  let open = 0, closed = 0;
  for (const n of p.items?.nodes ?? []) {
    const s = n.content?.state;
    if (s === "OPEN") open++;
    else if (s === "CLOSED" || s === "MERGED") closed++;
  }
  const total = open + closed;
  return { open, pct: total ? closed / total : 0 };
}

export const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 20) {
      nodes {
        id number title shortDescription url closed updatedAt
        items(first: 100) {
          totalCount
          nodes { content { __typename ... on Issue { state } ... on PullRequest { state } } }
        }
        repositories(first: 20) { nodes { nameWithOwner } }
      }
    }
  }
}`;

const DELETE_MUTATION = `
  mutation DeleteProject($projectId: ID!) {
    deleteProjectV2(input: { projectId: $projectId }) {
      projectV2 { id }
    }
  }
`;

interface ProjectRowProps {
  p: GhProject;
  running: number;
  paused: number;
  onPlan: (p: GhProject) => void;
  onBoard: (p: GhProject) => void;
  onDelete: (p: GhProject) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}

export function ProjectRow({ p, running, paused, onPlan, onBoard, onDelete, menuOpenId, setMenuOpenId }: ProjectRowProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen  = menuOpenId === p.id;
  const [hover, setHover] = useState(false);
  const status = projStatus(p);
  const repos  = (p.repositories?.nodes ?? []).map(r => r.nameWithOwner.split("/")[1] ?? r.nameWithOwner);
  const { open, pct } = projectProgress(p);

  // Close on an outside mousedown (not click — so the menu doesn't unmount before an item's click fires).
  useClickOutside(menuRef, () => setMenuOpenId(null), isOpen);

  return (
    <Grid
      onClick={() => onPlan(p)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      cols="1fr auto" gap={16} align="center"
      style={{
        padding: "13px 16px 13px 18px",
        cursor: "pointer", borderLeft: "2px solid " + (hover ? "var(--accent)" : "transparent"),
        background: hover ? "var(--bg-elev)" : "var(--bg-panel)",
      }}>
      <Box style={{ minWidth: 0 }}>
        <Row gap={9} wrap style={{ marginBottom: 5 }}>
          <Box as="span" bg={STATUS_META[status].dot} radius={99} style={{ width: 7, height: 7, flexShrink: 0 }} />
          <Text mono size={10} tone="dim">#{p.number}</Text>
          <Text as="h3" size={14} weight={600} style={{ margin: 0, fontFamily: "var(--sans)", color: "var(--fg)" }}>{p.title}</Text>
          <Chip tone={tagTone(STATUS_META[status].cls)} style={{ fontSize: 9.5 }}>{STATUS_META[status].label}</Chip>
          {repos.slice(0, 2).map(r => <Chip key={r} style={{ fontSize: 9.5 }}>{r}</Chip>)}
          {repos.length > 2 && <Chip style={{ fontSize: 9.5 }}>+{repos.length - 2}</Chip>}
        </Row>
        <Text as="div" tone="muted" size={12} style={{ lineHeight: 1.5, marginBottom: 9, maxWidth: 620 }}>
          {p.shortDescription ?? "No description."}
        </Text>
        <Row className="mono" gap={16} wrap style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
          {p.items.totalCount > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</Box>}
          {open > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{open}</b> open</Box>}
          {p.items.totalCount > 0 && <ProgressBar pct={pct} />}
          <Text tone="dim">updated {timeAgo(p.updatedAt)}</Text>
        </Row>
      </Box>

      <Row gap={10} style={{ flexShrink: 0 }}>
        <FleetPill running={running} paused={paused} />
        <Box as="span" className="mono" style={{
          fontSize: 10.5, whiteSpace: "nowrap",
          color: hover ? "var(--accent)" : "var(--fg-dim)", transition: "color .12s",
        }}>open planning →</Box>

        {/* ⋯ menu — stops row-click propagation */}
        {/* eslint-disable-next-line no-restricted-syntax -- click-outside menu needs a real DOM ref (Box isn't forwardRef) */}
        <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            style={{ height: 26, width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : p.id)}
            title="More options"
          >
            <MoreHorizontal size={14} />
          </Button>

          {isOpen && (
            <Box className="menu" style={{ minWidth: 178 }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard(p); }}>
                <ExternalLink size={12} /> open board on GitHub
              </button>
              <Box style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(p); }}>
                <Trash2 size={12} /> delete project
              </button>
            </Box>
          )}
        </div>
      </Row>
    </Grid>
  );
}

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
    githubToken, setWorkspace, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard,
    setPlanningContext, setPlanningTitle, setPlanningSession, deleteLocalProject, dismissProject,
    addDraftProject, projectKeyAlias, setProjectBlueprintId, activeBlueprintId,
  } = useAppStore();
  const [title, setTitle]         = useState("");
  const [newOpen, setNewOpen]     = useState(false);
  // New-project form: dismiss by clicking outside (no cancel button). The typed title is KEPT in
  // state on dismiss, so a mistaken click outside doesn't lose it — reopening restores what was typed.
  const newFormRef = useRef<HTMLDivElement>(null);
  const newBtnRef  = useRef<HTMLButtonElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Published-delete is a two-step Keep-vs-Delete flow (#1216): the modal first offers Keep (default,
  // safe) vs "delete everything"; choosing the destructive path arms a deliberate second confirm
  // before it runs the GitHub project DELETE_MUTATION.
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  // The third, most-destructive path: also permanently DELETE the GitHub repositories + their code.
  const [confirmDeleteRepos, setConfirmDeleteRepos] = useState(false);

  // Dismiss the new-project form on an outside click (#…) — closes without clearing the title, so a
  // stray click keeps what was typed. The trigger button is excluded so it keeps toggling the form.
  useClickOutside(newFormRef, () => setNewOpen(false), newOpen, newBtnRef);

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

  function closeDeleteModal() {
    setDeleteTarget(null);
    setDeleteError(null);
    setConfirmDeleteAll(false);
    setConfirmDeleteRepos(false);
  }

  // Remove ONLY the local footprint of a published project (#1216 "Keep the app"): the on-disk hub +
  // per-project store state + a persisted dismissal so the next GitHub sync doesn't re-list it. The
  // GitHub board / milestones / issues / repos are left completely untouched (no DELETE_MUTATION).
  // Shared by Keep and by "delete everything" (which layers the GitHub teardown on top).
  async function removeLocalFootprint(p: GhProject) {
    // delete_project_dir clears Windows read-only files first (#793) and handles relocated worktrees
    // without following a node_modules junction into the shared main node_modules.
    await safeInvoke("delete_project_dir", { projectKey: p.title }, undefined,
      (e) => console.warn(`delete_project_dir failed: ${e}`));
    // Pass BOTH the title and the GitHub node id: deleteLocalProject resolves the node id through the
    // alias to the slug-keyed maps (#997) and guards undefined slices (#874/#791), and clears the
    // active/planning session if this was the open project.
    deleteLocalProject([p.title, p.id]);
    // Persist the removal so the next GitHub sync (which still returns closed / not-yet-purged
    // boards) doesn't re-add the card (#85).
    dismissProject(p.id);
    setProjects(prev => prev.filter(x => x.id !== p.id));
  }

  // "Keep the app — stop tracking it here" (#1216, the default / safe path): local cleanup only.
  async function handleDeleteKeep() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    await removeLocalFootprint(deleteTarget);
    setDeleting(false);
    closeDeleteModal();
  }

  // "Delete everything" (#1216, the explicitly destructive path): the local cleanup PLUS the GitHub
  // Project DELETE_MUTATION (tears down the project BOARD — not the repos / their code).
  async function handleDeleteEverything() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    // Best-effort GitHub delete: a project already deleted on the web returns a GraphQL "could not
    // resolve to a node" error, which must NOT block removing it locally — that was the bug where
    // stale projects couldn't be cleared (#85).
    if (githubToken) {
      try {
        await invoke("github_graphql", {
          token: githubToken,
          query: DELETE_MUTATION,
          variables: { projectId: deleteTarget.id },
        });
      } catch (e) {
        console.warn(`github project delete failed (removing locally anyway): ${e}`);
      }
    }
    await removeLocalFootprint(deleteTarget);
    setDeleting(false);
    closeDeleteModal();
  }

  // "Delete everything + repositories" — the MOST destructive path: handleDeleteEverything PLUS a
  // best-effort REST delete of every linked GitHub repository (needs the token's `delete_repo` scope).
  // Repos go first; failures are collected and surfaced (the local copy + board still get removed).
  async function handleDeleteWithRepos() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    const repos = deleteTarget.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const failed: string[] = [];
    if (githubToken) {
      for (const fullName of repos) {
        try {
          await invoke("github_delete", { token: githubToken, path: `repos/${fullName}` });
        } catch (e) {
          console.warn(`repo delete failed for ${fullName}: ${e}`);
          failed.push(fullName);
        }
      }
      // Then tear down the project board (best-effort, like handleDeleteEverything).
      try {
        await invoke("github_graphql", {
          token: githubToken,
          query: DELETE_MUTATION,
          variables: { projectId: deleteTarget.id },
        });
      } catch (e) {
        console.warn(`github project delete failed (removing locally anyway): ${e}`);
      }
    }
    await removeLocalFootprint(deleteTarget);
    setDeleting(false);
    if (failed.length > 0) {
      // Local copy + board are gone, but some repos couldn't be deleted — surface which (a missing
      // `delete_repo` scope is the usual cause) and keep the modal open so the message is seen.
      setDeleteError(
        `Couldn't delete ${failed.length} repositor${failed.length === 1 ? "y" : "ies"}: ${failed.join(", ")}. ` +
          "Your token may lack the `delete_repo` scope — delete them on GitHub. The local copy and project board were removed.",
      );
    } else {
      closeDeleteModal();
    }
  }

  const titleTrimmed = title.trim();
  // One title matcher (#380) — case/whitespace-insensitive — so the guard that no-ops a
  // re-typed existing-project name agrees with everywhere else "title already taken" is judged.
  const titleConflict = findByTitle(visibleProjects, titleTrimmed, p => p.title);

  function handleStartPlanning() {
    // Never start over an existing published project. The button is disabled on titleConflict,
    // but the Enter-key handler isn't, so this guard is what actually stops a re-typed
    // published-project name from forking a confusing duplicate (#380).
    if (!titleTrimmed || titleConflict) return;
    // New project starts as a DRAFT (#379). Its workspace key is a freshly minted STABLE id
    // (#1741) — opaque, not title-derived — so the on-disk hub never moves on a rename and two
    // same-titled projects get distinct keys. The title is display-only from here. (A fresh id
    // can't collide with an existing folder, so the old title-key path's stale-folder cleanup —
    // remove/delete the prior same-named draft — is no longer needed: same-named drafts now
    // simply coexist as distinct projects.)
    const draftKey = mintProjectId();
    setPlanningTitle(titleTrimmed);
    // The pitch is described in the planning conversation now — creation only needs the title (#…).
    setPlanningContext("", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(draftKey, { title: titleTrimmed, pitch: "", createdAt: Date.now() });
    // Persist the user's title into the hub (`projects/<key>/.title`) so the on-disk name is their
    // input from the start — not a title fabricated from the opaque key when `goal.md` isn't authored
    // yet (which then leaked into the session skill-group name, GitHub structure, and tab labels).
    fireInvoke("set_project_title", { projectKey: draftKey, title: titleTrimmed });
    // Bind the blueprint AT CREATION (#988) — the explicit consent point — capturing whatever's
    // selected now. Opening the project later never adopts the (freely-changing) global selection,
    // so its blueprint can't switch without the user's intent.
    setProjectBlueprintId(draftKey, activeBlueprintId || DEFAULT_BLUEPRINT_ID);
    setPlanningSession(draftKey);
    setNewOpen(false);
    setTitle("");
    setProjectsView("planning");
  }

  const publishedAndDrafts = publishedCount + fDrafts.length;
  // The main (projects) column is empty when there are no projects or drafts; the
  // blueprints rail shows its own empty state independently.
  const projectsEmpty = publishedCount === 0 && fDrafts.length === 0;
  const q = query.trim().toLowerCase();
  const sortBtn = (active: boolean) => ({
    height: 28, padding: "0 11px", border: 0, cursor: "pointer", fontSize: 10.5,
    background: active ? "var(--bg-elev2)" : "transparent", color: active ? "var(--fg)" : "var(--fg-dim)",
  } as const);

  return (
    <>
      {/* ░░ MAIN — projects ░░
          A min-width floor (not 0) so the projects column stays usable in a narrow / half window:
          the shrinkable blueprints rail (below) gives back space first, instead of this column
          collapsing to nothing and the fixed-width rail overflowing the clipped section. */}
      <Stack style={{ flex: "1 1 0", minWidth: 320 }}>
        {/* fixed header: title · summary · sync/new · new-project form · search+sort */}
        <Box style={{ flex: "0 0 auto", padding: "20px 28px 0" }}>
          <Row align="start" gap={14}>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Row gap={10}>
                <Text as="h2" mono size={19} weight={600} style={{ margin: 0, color: "var(--fg)" }}>Projects</Text>
                <Box as="span" className="mono" pad={[1, 7]} bg="var(--bg-elev2)" border="soft" radius={8} style={{ fontSize: 10, color: "var(--fg-muted)"}}>{publishedAndDrafts}</Box>
              </Row>
              <Row className="mono" gap={8} wrap style={{ color: "var(--fg-muted)", fontSize: 11.5, marginTop: 7 }}>
                <Text tone="success">● github connected</Text>
                <Text tone="dim">·</Text>
                <Box as="span">{totalSummary}</Box>
                {lastSync && (
                  <>
                    <Text tone="dim">·</Text>
                    <Text tone="dim">last sync {timeAgo(lastSync.toISOString())}</Text>
                  </>
                )}
              </Row>
            </Box>
            <Button variant="ghost" onClick={fetchProjects} disabled={loading}>
              {loading ? "syncing…" : "↻ sync"}
            </Button>
            <button ref={newBtnRef} className="btn primary" onClick={() => setNewOpen(o => !o)}>+ New project</button>
          </Row>

          {/* new project — inline; click outside to dismiss (the title is kept for next time) */}
          {newOpen && (
            // eslint-disable-next-line no-restricted-syntax -- click-outside form needs a real DOM ref (Box isn't forwardRef)
            <div ref={newFormRef} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginTop: 14,
              background: "var(--bg-panel)", border: "1px solid var(--accent-dim)", borderRadius: 8,
            }}>
              <Text mono size={10} tone="dim" style={{ whiteSpace: "nowrap" }}>+ plan</Text>
              <input
                autoFocus
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); if (e.key === "Escape") setNewOpen(false); }}
                placeholder="project title…"
                className="mono"
                style={{
                  flex: 1, minWidth: 0, background: "none", border: "none", outline: "none",
                  fontSize: 12, color: "var(--fg)",
                }}
              />
              {titleConflict && (
                <Text mono size={10} tone="danger" style={{ whiteSpace: "nowrap" }}>⚠ exists</Text>
              )}
              <Button
                onClick={handleStartPlanning}
                disabled={!titleTrimmed || !!titleConflict}
                variant="primary"
                style={{ height: 24, fontSize: 10.5, opacity: (titleTrimmed && !titleConflict) ? 1 : 0.4, whiteSpace: "nowrap" }}
              >start planning →</Button>
            </div>
          )}

          {/* search + sort */}
          <Row gap={12} wrap style={{ marginTop: 16, paddingBottom: 16 }}>
            <Row gap={8} style={{ height: 30, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", flex: "0 1 300px", minWidth: 0 }}>
              <Search size={13} style={{ color: "var(--fg-dim)" }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="search projects & blueprints…"
                className="mono"
                style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 11, color: "var(--fg)" }}
              />
            </Row>
            <Row gap={7}>
              <Text mono size={10} tone="dim">sort</Text>
              <Row align="stretch" style={{ background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
                <button className="mono" onClick={() => setSort("recency")} style={sortBtn(sort === "recency")}>recency</button>
                <Box as="span" bg="var(--border-soft)" style={{ width: 1}} />
                <button className="mono" onClick={() => setSort("name")} style={sortBtn(sort === "name")}>name</button>
              </Row>
            </Row>
            {q && <Text mono size={10} tone="dim" style={{ marginLeft: "auto" }}>{grandTotal} match{grandTotal !== 1 ? "es" : ""}</Text>}
          </Row>
        </Box>

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

      {/* Published-project delete — Keep vs Delete (#1216). A published project is a real shipped app
          on GitHub (board + milestones + issues + repos), so removing it from base-studio-code must
          NOT silently tear down that structure. Keep (default/safe) = local cleanup only; Delete
          everything (deliberate, secondary) layers the GitHub project DELETE_MUTATION on top, behind
          an explicit second confirm. */}
      {deleteTarget && (
        <Box className="modal-scrim" onClick={overlayDismiss(deleting ? undefined : closeDeleteModal)}>
          <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 460, maxWidth: "90vw",
          }}>
            {confirmDeleteRepos ? (
              (() => {
                const repoNames = deleteTarget.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
                return (
                  <>
                    <Text as="h3" mono size={14} tone="danger" style={{ margin: "0 0 8px" }}>
                      Delete everything + repositories?
                    </Text>
                    <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
                      This <b style={{ color: "var(--fg)" }}>permanently deletes</b> the local copy, the GitHub project
                      board, and{" "}
                      <b style={{ color: "var(--fg)" }}>
                        {repoNames.length > 0 ? `${repoNames.length} GitHub repositor${repoNames.length === 1 ? "y" : "ies"}` : "the linked repositories"} and all their code
                      </b>{" "}
                      for <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b>.{" "}
                      <b style={{ color: "var(--danger)" }}>This cannot be undone.</b>
                    </Text>
                    {repoNames.length > 0 && (
                      <Text as="div" mono size={11} tone="muted" style={{ marginBottom: 16, lineHeight: 1.7 }}>
                        {repoNames.map((r) => <Box key={r}>· {r}</Box>)}
                      </Text>
                    )}
                    {deleteError && (
                      <Box className="mono" pad={[8, 12]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius={4} style={{ marginBottom: 14,
                        border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                        fontSize: 11, color: "var(--danger)",
                      }}>
                        {deleteError}
                      </Box>
                    )}
                    <Row gap={8} align="stretch" justify="end">
                      <Button variant="ghost" onClick={() => { setConfirmDeleteRepos(false); setDeleteError(null); }} disabled={deleting}>back</Button>
                      <Button danger onClick={handleDeleteWithRepos} disabled={deleting} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Trash2 size={12} />
                        {deleting ? "deleting…" : "delete everything + repos"}
                      </Button>
                    </Row>
                  </>
                );
              })()
            ) : !confirmDeleteAll ? (
              <>
                <Text as="h3" mono size={14} style={{ margin: "0 0 8px", color: "var(--fg)" }}>
                  Remove “{deleteTarget.title}”?
                </Text>
                <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
                  This project is published to GitHub. Choose whether to keep the shipped app on GitHub
                  or delete everything.
                </Text>
                {deleteError && (
                  <Box className="mono" pad={[8, 12]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius={4} style={{ marginBottom: 14,
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </Box>
                )}
                {/* Keep — the default / safe primary action. */}
                <Button
                  variant="primary"
                  onClick={handleDeleteKeep}
                  disabled={deleting}
                  autoFocus
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", marginBottom: 10 }}
                >
                  <Box as="span" style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>Keep the app — stop tracking it here</Box>
                  <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                    Removes the local copy only. Your GitHub project board, milestones, issues, and repos stay intact.
                  </Box>
                </Button>
                {/* Delete everything — secondary; arms the explicit destructive confirm (NOT the default). */}
                <Button
                  variant="ghost"
                  onClick={() => { setConfirmDeleteAll(true); setDeleteError(null); }}
                  disabled={deleting}
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
                >
                  <Box as="span" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                    <Trash2 size={12} /> Delete everything
                  </Box>
                  <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                    Removes the local copy AND deletes the GitHub project board. (Your repos and their code are not deleted.)
                  </Box>
                </Button>
                {/* Delete everything + repositories — the MOST destructive; arms its own confirm. */}
                <Button
                  variant="ghost"
                  onClick={() => { setConfirmDeleteRepos(true); setDeleteError(null); }}
                  disabled={deleting}
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
                >
                  <Box as="span" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                    <Trash2 size={12} /> Delete everything + repositories
                  </Box>
                  <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                    Removes the local copy, the GitHub project board, AND permanently deletes the linked GitHub repositories and all their code. This cannot be undone.
                  </Box>
                </Button>
                <Row gap={8} align="stretch" justify="end">
                  <Button variant="ghost" onClick={closeDeleteModal} disabled={deleting}>cancel</Button>
                </Row>
              </>
            ) : (
              <>
                <Text as="h3" mono size={14} tone="danger" style={{ margin: "0 0 8px" }}>
                  Delete everything?
                </Text>
                <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
                  This permanently deletes the <b style={{ color: "var(--fg)" }}>GitHub project board</b> for{" "}
                  <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b> (its milestones and issue cards) and
                  removes the local copy. <b style={{ color: "var(--fg)" }}>Your repositories and their code are not deleted</b> —
                  only the project board is.
                </Text>
                {deleteError && (
                  <Box className="mono" pad={[8, 12]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius={4} style={{ marginBottom: 14,
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </Box>
                )}
                <Row gap={8} align="stretch" justify="end">
                  <Button
                    variant="ghost"
                    onClick={() => { setConfirmDeleteAll(false); setDeleteError(null); }}
                    disabled={deleting}
                  >back</Button>
                  <Button
                    danger
                    onClick={handleDeleteEverything}
                    disabled={deleting}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Trash2 size={12} />
                    {deleting ? "deleting…" : "delete everything"}
                  </Button>
                </Row>
              </>
            )}
          </Box>
        </Box>
      )}
    </>
  );
}
