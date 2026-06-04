import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, MoreHorizontal, Trash2, GitFork } from "lucide-react";
import { useAppStore } from "../../store";
import { useFleetLive } from "../../hooks/useFleetLive";
import { sanitizeProjectKey, isKnownPublishedKey, findByTitle } from "../../lib/projectPaths";

// A project's lifecycle, derived from GitHub state (#499 design).
type ProjStatus = "active" | "drafting" | "shipped";
const STATUS_META: Record<ProjStatus, { label: string; cls: string; dot: string }> = {
  active:   { label: "active",   cls: "green", dot: "var(--success)" },
  drafting: { label: "drafting", cls: "amber", dot: "var(--accent)" },
  shipped:  { label: "shipped",  cls: "",      dot: "var(--fg-dim)" },
};
function projStatus(p: { closed: boolean; items: { totalCount: number } }): ProjStatus {
  if (p.closed) return "shipped";
  return p.items.totalCount === 0 ? "drafting" : "active";
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

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 2px 0", marginTop: 4 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</span>
      <span className="tag" style={{ fontSize: 9 }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
    </div>
  );
}

interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 20) {
      nodes {
        id number title shortDescription url closed updatedAt
        items { totalCount }
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

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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
          {status === "drafting" && <span style={{ color: "var(--accent)" }}>plan in progress</span>}
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
              borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 168,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard(p); }}>
                <ExternalLink size={12} /> board on GitHub
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

export function ProjectsList() {
  const { githubToken, activeScreen, setScreen, setProjectsView, setActiveProjectMeta, openGithubBoard, setPlanningContext, setPlanningTitle, setPlanningSession, deleteLocalProject, hiddenProjectIds, dismissProject, localDraftProjects, addDraftProject, removeDraftProject, projectKeyAlias } = useAppStore();
  const [projects, setProjects]   = useState<GhProject[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSync, setLastSync]   = useState<Date | null>(null);
  const [title, setTitle]         = useState("");
  const [pitch, setPitch]         = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Live fleet (for the per-project "agents running" pill).
  const { workers } = useFleetLive();

  const fetchProjects = useCallback(() => {
    if (!githubToken) return;
    setLoading(true);
    setError(null);
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken,
      query: PROJECTS_QUERY,
      variables: null,
    })
      .then(data => {
        setProjects(data.viewer?.projectsV2?.nodes ?? []);
        setLastSync(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken]);

  // Re-fetch whenever the Projects tab becomes active (the screen stays mounted
  // across navigation, so a plain mount effect wouldn't refresh on re-open) as
  // well as on token change, so newly created/renamed projects appear.
  useEffect(() => {
    if (activeScreen === "projects") fetchProjects();
  }, [activeScreen, fetchProjects]);

  // The GitHub Projects v2 board now lives on the GitHub page (#498).
  function handleOpenGithubBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    setScreen("github");
    openGithubBoard("board");
  }

  function handleEditPlan(p: GhProject) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
    setPlanningContext(p.shortDescription ?? p.title, repo);
    // Key the session by the project name so the working directory is stable and
    // human-readable, and matches a from-scratch session of the same name. The
    // GitHub node id stays in activeProjectId for API calls only.
    setPlanningSession(p.title);
    setProjectsView("planning");
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    // Best-effort GitHub delete: a project already deleted on the web returns a
    // GraphQL "could not resolve to a node" error, which must NOT block removing
    // it locally — that was the bug where stale projects couldn't be cleared.
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
    // Always remove the local footprint: the on-disk hub + per-project store state,
    // keyed by the planning session key (title) and the GitHub id.
    await invoke("delete_project_dir", { projectKey: deleteTarget.title })
      .catch((e) => console.warn(`delete_project_dir failed: ${e}`));
    deleteLocalProject([deleteTarget.title, deleteTarget.id]);
    // Persist the removal so the next GitHub sync doesn't re-add it (the list is
    // re-fetched from GitHub, which still returns closed / not-yet-purged projects).
    dismissProject(deleteTarget.id);
    setProjects(prev => prev.filter(p => p.id !== deleteTarget.id));
    setDeleting(false);
    setDeleteTarget(null);
  }

  // The GitHub list is re-fetched on every sync, so a project removed in-app is
  // filtered out here (persisted) rather than only spliced from local state.
  const visibleProjects = projects.filter(p => !hiddenProjectIds.includes(p.id));

  const titleTrimmed = title.trim();
  // One title matcher (#380) — case/whitespace-insensitive — so the guard that no-ops a
  // re-typed existing-project name agrees with everywhere else "title already taken" is judged.
  const titleConflict = findByTitle(visibleProjects, titleTrimmed, p => p.title);

  async function handleStartPlanning() {
    // Never start over — or delete the folder of — an existing project. The button is disabled
    // on titleConflict, but the Enter-key handler isn't, so this guard is what actually stops a
    // re-typed published-project name from wiping its plan (#380).
    if (!titleTrimmed || titleConflict) return;
    // New project starts as a DRAFT (#379). The planning-dir id is the sanitized title — a
    // clean, stable folder name (no random suffix), so the folder and the project resolve the
    // same regardless of how it is later reopened or published. Re-using a title replaces an
    // earlier *unpublished* draft, so clear that draft's folder FIRST for a stale-free start.
    const draftKey = sanitizeProjectKey(titleTrimmed);
    removeDraftProject(draftKey);
    deleteLocalProject([draftKey]);
    // Belt-and-suspenders: never delete a folder that belongs to a project already published
    // to GitHub (its node id is aliased to this name) — even if titleConflict missed it because
    // the project list hadn't loaded. Only a genuinely unpublished draft's folder is cleared.
    if (!isKnownPublishedKey(draftKey, projectKeyAlias)) {
      await invoke("delete_project_dir", { projectKey: draftKey }).catch(() => {});
    }
    setPlanningTitle(titleTrimmed);
    setPlanningContext(pitch.trim(), "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(draftKey, { title: titleTrimmed, pitch: pitch.trim(), createdAt: Date.now() });
    setPlanningSession(draftKey);
    setProjectsView("planning");
  }

  function reopenDraft(key: string, d: { title: string; pitch: string }) {
    setPlanningTitle(d.title);
    setPlanningContext(d.pitch, "");
    setActiveProjectMeta(null, "", "", 0);
    setPlanningSession(key);
    setProjectsView("planning");
  }

  function deleteDraft(key: string) {
    removeDraftProject(key);
    deleteLocalProject([key]);
    void invoke("delete_project_dir", { projectKey: key }).catch(() => {});
  }

  const repos = new Set(visibleProjects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? []));

  // Per-project live fleet counts: a worker belongs to a project when its repo is
  // one of the project's repos (running vs parked = asking/waiting/blocked).
  const fleetByProject = useMemo(() => {
    const m: Record<string, { running: number; paused: number }> = {};
    for (const p of visibleProjects) {
      const projRepos = new Set((p.repositories?.nodes ?? []).map(r => r.nameWithOwner));
      let running = 0, paused = 0;
      for (const w of workers) {
        if (!projRepos.has(w.repo)) continue;
        if (w.status === "running") running++;
        else if (w.status !== "idle") paused++;
      }
      m[p.id] = { running, paused };
    }
    return m;
  }, [visibleProjects, workers]);

  // Group the published projects by lifecycle for the sectioned list (#499).
  const grouped = useMemo(() => {
    const order: ProjStatus[] = ["active", "drafting", "shipped"];
    const by: Record<ProjStatus, GhProject[]> = { active: [], drafting: [], shipped: [] };
    for (const p of visibleProjects) by[projStatus(p)].push(p);
    return order.map(s => [s, by[s]] as const).filter(([, arr]) => arr.length > 0);
  }, [visibleProjects]);

  // Jump to the GitHub Portfolio (where the analytics + live Fleet now live, #498).
  function gotoPortfolio() { setScreen("github"); }

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "24px 32px", minWidth: 0 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>Projects</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--success)" }}>● github connected</span>
              {!loading && visibleProjects.length > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {visibleProjects.length} project{visibleProjects.length !== 1 ? "s" : ""}
                    {repos.size > 0 ? ` across ${repos.size} repo${repos.size !== 1 ? "s" : ""}` : ""}
                  </span>
                </>
              )}
              {lastSync && (
                <>
                  <span>·</span>
                  <span>last sync {timeAgo(lastSync.toISOString())}</span>
                </>
              )}
            </div>
          </div>
          <button className="btn ghost" onClick={fetchProjects} disabled={loading}>
            {loading ? "syncing…" : "↻ sync"}
          </button>
          <button className="btn">import existing</button>
        </div>

        {/* Analytics moved-out signpost (#498): the portfolio + live Fleet now live
            on the GitHub page. */}
        <div onClick={gotoPortfolio} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", marginBottom: 16, cursor: "pointer",
          background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
        }}>
          <GitFork size={13} style={{ color: "var(--info)" }} />
          <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
            Portfolio analytics &amp; live <b style={{ color: "var(--fg)" }}>Fleet</b> now live under <b style={{ color: "var(--fg)" }}>GitHub → Projects</b>.
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--info)" }}>view analytics →</span>
        </div>

        {/* Plan new project CTA */}
        <div style={{
          background: "linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 86%), var(--bg-panel) 70%)",
          border: "1px solid var(--accent-dim)",
          borderRadius: 12,
          padding: "18px 20px",
          marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 6,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>C</div>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>Plan a new project</h3>
            <span className="tag amber" style={{ fontSize: 9.5 }}>creates milestones + issues on github</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Title row */}
            <div style={{
              padding: "8px 14px",
              background: "var(--bg-canvas)", borderRadius: 8,
              border: "1px solid " + (titleConflict ? "var(--danger)" : "var(--border-soft)"),
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>title</span>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Tab") e.preventDefault(); }}
                placeholder="project title…"
                autoFocus
                style={{
                  flex: 1, background: "none", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
                }}
              />
              {titleConflict && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)", whiteSpace: "nowrap" }}>
                  ⚠ already exists
                </span>
              )}
            </div>
            {/* Pitch row */}
            <div style={{
              padding: "8px 14px",
              background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8,
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 13 }}>▸</span>
              <input
                value={pitch}
                onChange={e => setPitch(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); }}
                placeholder="describe what you want to build… (optional)"
                style={{
                  flex: 1, background: "none", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
                }}
              />
              <button
                onClick={handleStartPlanning}
                disabled={!titleTrimmed || !!titleConflict}
                className="btn primary"
                style={{ height: 26, fontSize: 11, opacity: (titleTrimmed && !titleConflict) ? 1 : 0.4 }}
              >start planning →</button>
            </div>
          </div>
        </div>

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

        {!loading && visibleProjects.length === 0 && !error && (
          <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
            No GitHub Projects found. Create one at github.com/your-org to get started.
          </div>
        )}

        {(() => {
          const publishedTitles = new Set(visibleProjects.map(p => p.title.toLowerCase()));
          const drafts = Object.entries(localDraftProjects)
            .filter(([, d]) => !publishedTitles.has(d.title.toLowerCase()))
            .sort((a, b) => b[1].createdAt - a[1].createdAt);
          if (drafts.length === 0) return null;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }}>
              {drafts.map(([key, d]) => (
                <div key={key} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                  background: "var(--bg-elev)", border: "1px dashed var(--border-soft)", borderRadius: "var(--r-md)",
                }}>
                  <div onClick={() => reopenDraft(key, d)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="tag amber">draft</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>{d.title}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>not yet on GitHub</span>
                    </div>
                    {d.pitch && (
                      <div style={{ marginTop: 4, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.pitch}</div>
                    )}
                  </div>
                  <button
                    className="btn ghost"
                    style={{ height: 24, padding: "0 8px", fontSize: 10.5, color: "var(--fg-muted)" }}
                    onClick={() => reopenDraft(key, d)}
                  >resume →</button>
                  <button
                    title="Delete draft (removes its local plan files)"
                    onClick={() => deleteDraft(key)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-dim)", padding: 4 }}
                  ><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Grouped published projects: Active · Drafting · Shipped */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {grouped.map(([status, items]) => (
            <div key={status} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <GroupLabel label={STATUS_META[status].label} count={items.length} />
              <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
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
          ))}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div style={{
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-lg)", padding: "24px 28px", width: 420, maxWidth: "90vw",
          }}>
            <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>
              Delete project?
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b> will be deleted from GitHub (if it still exists)
              and its local planning data removed. Linked issues and milestones are not deleted.
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
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                disabled={deleting}
              >
                cancel
              </button>
              <button
                className="btn danger"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Trash2 size={12} />
                {deleting ? "deleting…" : "delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
