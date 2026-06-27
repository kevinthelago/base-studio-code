import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, MoreHorizontal, Trash2, Search } from "lucide-react";
import { useAppStore } from "@/store";
import { mintProjectId, findByTitle } from "@/shared/lib/core/projectPaths";
import { timeAgo, timeAgoMs } from "@/shared/lib/core/format";
import { overlayDismiss } from "@/shared/hooks/useModalDismiss";
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
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 9px", borderRadius: 99,
      fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--success)",
      background: "color-mix(in oklch, var(--success), transparent 88%)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 70%)",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--success)", animation: "pulse 1.4s ease-in-out infinite" }} />
      <span>{running} agent{running !== 1 ? "s" : ""} running</span>
      {paused > 0 && <span style={{ color: "var(--fg-dim)" }}>· {paused} paused</span>}
    </span>
  );
}

/** Lifecycle sub-group header within the Projects section (Active · Drafting · Shipped). */
function GroupHeader({ label, count, dot }: { label: string; count: number; dot: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 7px", paddingLeft: 2 }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: dot }} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</span>
      <span style={{ padding: "0 5px", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 9, background: "var(--bg-elev2)", color: "var(--fg-muted)", border: "1px solid var(--border-soft)" }}>{count}</span>
    </div>
  );
}

/** Milestone-progress bar: fraction of the project's items that are closed. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <span title={`${Math.round(pct * 100)}% of items closed`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 56, height: 4, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${pct * 100}%`, background: pct >= 1 ? "var(--success)" : "var(--accent)" }} />
      </span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{Math.round(pct * 100)}%</span>
    </span>
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

  // Close the menu on an outside mousedown, but NOT on a mousedown inside it —
  // otherwise the menu unmounts before a menu item's click fires.
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpenId(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isOpen, setMenuOpenId]);

  return (
    <div
      onClick={() => onPlan(p)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: "13px 16px 13px 18px", display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center",
        cursor: "pointer", borderLeft: "2px solid " + (hover ? "var(--accent)" : "transparent"),
        background: hover ? "var(--bg-elev)" : "var(--bg-panel)",
      }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5, flexWrap: "wrap" }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_META[status].dot, flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{p.number}</span>
          <h3 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{p.title}</h3>
          <span className={"tag " + STATUS_META[status].cls} style={{ fontSize: 9.5 }}>{STATUS_META[status].label}</span>
          {repos.slice(0, 2).map(r => <span key={r} className="tag" style={{ fontSize: 9.5 }}>{r}</span>)}
          {repos.length > 2 && <span className="tag" style={{ fontSize: 9.5 }}>+{repos.length - 2}</span>}
        </div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5, marginBottom: 9, maxWidth: 620 }}>
          {p.shortDescription ?? "No description."}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", flexWrap: "wrap" }}>
          {p.items.totalCount > 0 && <span><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</span>}
          {open > 0 && <span><b style={{ color: "var(--fg)" }}>{open}</b> open</span>}
          {p.items.totalCount > 0 && <ProgressBar pct={pct} />}
          <span style={{ color: "var(--fg-dim)" }}>updated {timeAgo(p.updatedAt)}</span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <FleetPill running={running} paused={paused} />
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10.5, whiteSpace: "nowrap",
          color: hover ? "var(--accent)" : "var(--fg-dim)", transition: "color .12s",
        }}>open planning →</span>

        {/* ⋯ menu — stops row-click propagation */}
        <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button
            className="btn ghost"
            style={{ height: 26, width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : p.id)}
            title="More options"
          >
            <MoreHorizontal size={14} />
          </button>

          {isOpen && (
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 178,
              boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
            }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard(p); }}>
                <ExternalLink size={12} /> open board on GitHub
              </button>
              <div style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(p); }}>
                <Trash2 size={12} /> delete project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
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
    githubToken, setScreen, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard,
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

  // Dismiss the new-project form on an outside click (#…) — closes without clearing the title, so a
  // stray click keeps what was typed. The trigger button is excluded so it keeps toggling the form.
  useEffect(() => {
    if (!newOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (newFormRef.current?.contains(t) || newBtnRef.current?.contains(t)) return;
      setNewOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [newOpen]);

  // The GitHub Projects v2 board now lives on the GitHub page (#498).
  function handleOpenGithubBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    setGithubTab("projects"); // so "← portfolio" returns to the Projects tab
    setScreen("github");
    openGithubBoard("board");
  }

  function handleEditPlan(p: GhProject) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
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
  }

  // Remove ONLY the local footprint of a published project (#1216 "Keep the app"): the on-disk hub +
  // per-project store state + a persisted dismissal so the next GitHub sync doesn't re-list it. The
  // GitHub board / milestones / issues / repos are left completely untouched (no DELETE_MUTATION).
  // Shared by Keep and by "delete everything" (which layers the GitHub teardown on top).
  async function removeLocalFootprint(p: GhProject) {
    // delete_project_dir clears Windows read-only files first (#793) and handles relocated worktrees
    // without following a node_modules junction into the shared main node_modules.
    await invoke("delete_project_dir", { projectKey: p.title })
      .catch((e) => console.warn(`delete_project_dir failed: ${e}`));
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
    height: 28, padding: "0 11px", border: 0, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5,
    background: active ? "var(--bg-elev2)" : "transparent", color: active ? "var(--fg)" : "var(--fg-dim)",
  } as const);

  return (
    <>
      {/* ░░ MAIN — projects ░░
          A min-width floor (not 0) so the projects column stays usable in a narrow / half window:
          the shrinkable blueprints rail (below) gives back space first, instead of this column
          collapsing to nothing and the fixed-width rail overflowing the clipped section. */}
      <div style={{ flex: "1 1 0", minWidth: 320, display: "flex", flexDirection: "column" }}>
        {/* fixed header: title · summary · sync/new · new-project form · search+sort */}
        <div style={{ flex: "0 0 auto", padding: "20px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 19, fontWeight: 600, color: "var(--fg)" }}>Projects</h2>
                <span style={{ padding: "1px 7px", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 10, background: "var(--bg-elev2)", color: "var(--fg-muted)", border: "1px solid var(--border-soft)" }}>{publishedAndDrafts}</span>
              </div>
              <div style={{ color: "var(--fg-muted)", fontSize: 11.5, marginTop: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)" }}>
                <span style={{ color: "var(--success)" }}>● github connected</span>
                <span style={{ color: "var(--fg-dim)" }}>·</span>
                <span>{totalSummary}</span>
                {lastSync && (
                  <>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span style={{ color: "var(--fg-dim)" }}>last sync {timeAgo(lastSync.toISOString())}</span>
                  </>
                )}
              </div>
            </div>
            <button className="btn ghost" onClick={fetchProjects} disabled={loading}>
              {loading ? "syncing…" : "↻ sync"}
            </button>
            <button ref={newBtnRef} className="btn primary" onClick={() => setNewOpen(o => !o)}>+ New project</button>
          </div>

          {/* new project — inline; click outside to dismiss (the title is kept for next time) */}
          {newOpen && (
            <div ref={newFormRef} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginTop: 14,
              background: "var(--bg-panel)", border: "1px solid var(--accent-dim)", borderRadius: 8,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>+ plan</span>
              <input
                autoFocus
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); if (e.key === "Escape") setNewOpen(false); }}
                placeholder="project title…"
                style={{
                  flex: 1, minWidth: 0, background: "none", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
                }}
              />
              {titleConflict && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)", whiteSpace: "nowrap" }}>⚠ exists</span>
              )}
              <button
                onClick={handleStartPlanning}
                disabled={!titleTrimmed || !!titleConflict}
                className="btn primary"
                style={{ height: 24, fontSize: 10.5, opacity: (titleTrimmed && !titleConflict) ? 1 : 0.4, whiteSpace: "nowrap" }}
              >start planning →</button>
            </div>
          )}

          {/* search + sort */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, paddingBottom: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", flex: "0 1 300px", minWidth: 0 }}>
              <Search size={13} style={{ color: "var(--fg-dim)" }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="search projects & blueprints…"
                style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>sort</span>
              <div style={{ display: "flex", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
                <button onClick={() => setSort("recency")} style={sortBtn(sort === "recency")}>recency</button>
                <span style={{ width: 1, background: "var(--border-soft)" }} />
                <button onClick={() => setSort("name")} style={sortBtn(sort === "name")}>name</button>
              </div>
            </div>
            {q && <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{grandTotal} match{grandTotal !== 1 ? "es" : ""}</span>}
          </div>
        </div>

        {/* scroll area: errors · drafts chips · active/shipped groups · empty */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 28px 28px" }}>
          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 6, marginBottom: 16,
              background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            }}>
              {error.includes("read:project")
                ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
                : error}
            </div>
          )}

          {loading && visibleProjects.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              Loading projects…
            </div>
          )}

          {draftError && (
            <div style={{
              padding: "8px 12px", borderRadius: "var(--r-md)", marginBottom: 12, fontFamily: "var(--mono)", fontSize: 11,
              color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)",
            }}>{draftError}</div>
          )}

          {/* drafts — compact chips (click = resume · ✕ = delete) */}
          {fDrafts.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 20, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em", whiteSpace: "nowrap" }}>
                {fDrafts.length} draft{fDrafts.length !== 1 ? "s" : ""}
              </span>
              {fDrafts.map(d => (
                <span
                  key={d.key}
                  onClick={() => reopenDraft(d)}
                  title={d.pitch || undefined}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", cursor: "pointer" }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--accent)", flexShrink: 0 }} />
                  {d.title}
                  <span style={{ color: "var(--fg-dim)" }}>{timeAgoMs(d.sort)}</span>
                  <span
                    onClick={e => { e.stopPropagation(); setDraftDeleteTarget(d); }}
                    title="delete draft"
                    style={{ color: "var(--fg-dim)", cursor: "pointer", paddingLeft: 2 }}
                  >✕</span>
                </span>
              ))}
            </div>
          )}

          {/* published projects, grouped by lifecycle */}
          {(["active", "shipped"] as ProjStatus[]).map(status => {
            const items = grouped[status];
            if (items.length === 0) return null;
            return (
              <div key={status} style={{ marginBottom: 22 }}>
                <GroupHeader label={STATUS_META[status].label} count={items.length} dot={STATUS_META[status].dot} />
                <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "visible", opacity: status === "shipped" ? 0.82 : 1 }}>
                  {items.map((p, i) => (
                    <div key={p.id} style={{ borderTop: i ? "1px solid var(--border-soft)" : "none" }}>
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
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* empty (main column only — the rail has its own) */}
          {!loading && projectsEmpty && (
            q ? (
              <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
                No projects match “{query}”.
              </div>
            ) : !error && (
              <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
                Nothing here yet. Start a plan with <b style={{ color: "var(--fg-muted)" }}>+ New project</b>.
              </div>
            )
          )}
        </div>
      </div>

      {/* Published-project delete — Keep vs Delete (#1216). A published project is a real shipped app
          on GitHub (board + milestones + issues + repos), so removing it from base-studio-code must
          NOT silently tear down that structure. Keep (default/safe) = local cleanup only; Delete
          everything (deliberate, secondary) layers the GitHub project DELETE_MUTATION on top, behind
          an explicit second confirm. */}
      {deleteTarget && (
        <div className="modal-scrim" onClick={overlayDismiss(deleting ? undefined : closeDeleteModal)}>
          <div style={{
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-lg)", padding: "24px 28px", width: 460, maxWidth: "90vw",
          }}>
            {!confirmDeleteAll ? (
              <>
                <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>
                  Remove “{deleteTarget.title}”?
                </h3>
                <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                  This project is published to GitHub. Choose whether to keep the shipped app on GitHub
                  or delete everything.
                </p>
                {deleteError && (
                  <div style={{
                    padding: "8px 12px", borderRadius: 4, marginBottom: 14,
                    background: "color-mix(in oklch, var(--danger), transparent 88%)",
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </div>
                )}
                {/* Keep — the default / safe primary action. */}
                <button
                  className="btn primary"
                  onClick={handleDeleteKeep}
                  disabled={deleting}
                  autoFocus
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", marginBottom: 10 }}
                >
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>Keep the app — stop tracking it here</span>
                  <span style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5, fontFamily: "var(--mono)" }}>
                    Removes the local copy only. Your GitHub project board, milestones, issues, and repos stay intact.
                  </span>
                </button>
                {/* Delete everything — secondary; arms the explicit destructive confirm (NOT the default). */}
                <button
                  className="btn ghost"
                  onClick={() => { setConfirmDeleteAll(true); setDeleteError(null); }}
                  disabled={deleting}
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                    <Trash2 size={12} /> Delete everything
                  </span>
                  <span style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5, fontFamily: "var(--mono)" }}>
                    Removes the local copy AND deletes the GitHub project board. (Your repos and their code are not deleted.)
                  </span>
                </button>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={closeDeleteModal} disabled={deleting}>cancel</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--danger)" }}>
                  Delete everything?
                </h3>
                <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                  This permanently deletes the <b style={{ color: "var(--fg)" }}>GitHub project board</b> for{" "}
                  <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b> (its milestones and issue cards) and
                  removes the local copy. <b style={{ color: "var(--fg)" }}>Your repositories and their code are not deleted</b> —
                  only the project board is.
                </p>
                {deleteError && (
                  <div style={{
                    padding: "8px 12px", borderRadius: 4, marginBottom: 14,
                    background: "color-mix(in oklch, var(--danger), transparent 88%)",
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    className="btn ghost"
                    onClick={() => { setConfirmDeleteAll(false); setDeleteError(null); }}
                    disabled={deleting}
                  >back</button>
                  <button
                    className="btn danger"
                    onClick={handleDeleteEverything}
                    disabled={deleting}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Trash2 size={12} />
                    {deleting ? "deleting…" : "delete everything"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
