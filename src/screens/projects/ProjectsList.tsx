import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, MoreHorizontal, Trash2, Plus } from "lucide-react";
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

interface GhProjectItem { content: { __typename?: string; state?: string } | null }
interface GhProject {
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
function projectProgress(p: GhProject): { open: number; closed: number; pct: number } {
  let open = 0, closed = 0;
  for (const n of p.items?.nodes ?? []) {
    const s = n.content?.state;
    if (s === "OPEN") open++;
    else if (s === "CLOSED" || s === "MERGED") closed++;
  }
  const total = open + closed;
  return { open, closed, pct: total ? closed / total : 0 };
}

const PROJECTS_QUERY = `{
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

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── master-list rows ─────────────────────────────────────────────────────────

export function MiniProjRow({ p, selected, onSelect }: { p: GhProject; selected: boolean; onSelect: () => void }) {
  const status = projStatus(p);
  return (
    <div onClick={onSelect} style={{
      display: "grid", gridTemplateColumns: "10px 1fr auto", gap: 8, alignItems: "center",
      padding: "9px 10px", borderRadius: 5, cursor: "pointer",
      background: selected ? "var(--bg-elev)" : "transparent",
      border: "1px solid " + (selected ? "var(--border-soft)" : "transparent"),
      boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_META[status].dot }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.title}</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 2 }}>
          #{p.number} · {p.items.totalCount} item{p.items.totalCount !== 1 ? "s" : ""}
        </div>
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{timeAgo(p.updatedAt)}</span>
    </div>
  );
}

function MiniDraftRow({ d, selected, onSelect }: { d: { title: string; pitch: string }; selected: boolean; onSelect: () => void }) {
  return (
    <div onClick={onSelect} style={{
      display: "grid", gridTemplateColumns: "10px 1fr", gap: 8, alignItems: "center",
      padding: "9px 10px", borderRadius: 5, cursor: "pointer",
      background: selected ? "var(--bg-elev)" : "transparent",
      border: "1px solid " + (selected ? "var(--border-soft)" : "transparent"),
      boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_META.drafting.dot }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.title}</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 2 }}>draft · not on GitHub</div>
      </div>
    </div>
  );
}

// ── preview cards ────────────────────────────────────────────────────────────

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card" style={{ padding: "9px 11px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 17, fontWeight: 700, color: tone ?? "var(--fg)" }}>{value}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>{label}</div>
    </div>
  );
}

export function ProjectsList() {
  const { githubToken, activeScreen, setScreen, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard, setPlanningContext, setPlanningTitle, setPlanningSession, deleteLocalProject, hiddenProjectIds, dismissProject, localDraftProjects, addDraftProject, removeDraftProject, projectKeyAlias } = useAppStore();
  const [projects, setProjects]   = useState<GhProject[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSync, setLastSync]   = useState<Date | null>(null);
  const [title, setTitle]         = useState("");
  const [pitch, setPitch]         = useState("");
  const [menuOpen, setMenuOpen]   = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Master-detail selection: a project id, a draft key ("draft:<key>"), or "new".
  const [selected, setSelected]   = useState<string>("new");
  const menuRef = useRef<HTMLDivElement>(null);
  const { workers } = useFleetLive();

  const fetchProjects = useCallback(() => {
    if (!githubToken) return;
    setLoading(true);
    setError(null);
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken, query: PROJECTS_QUERY, variables: null,
    })
      .then(data => {
        setProjects(data.viewer?.projectsV2?.nodes ?? []);
        setLastSync(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken]);

  useEffect(() => {
    if (activeScreen === "projects") fetchProjects();
  }, [activeScreen, fetchProjects]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const visibleProjects = projects.filter(p => !hiddenProjectIds.includes(p.id));
  const titleTrimmed = title.trim();
  const titleConflict = findByTitle(visibleProjects, titleTrimmed, p => p.title);

  const drafts = useMemo(() => {
    const publishedTitles = new Set(visibleProjects.map(p => p.title.toLowerCase()));
    return Object.entries(localDraftProjects)
      .filter(([, d]) => !publishedTitles.has(d.title.toLowerCase()))
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
  }, [visibleProjects, localDraftProjects]);

  // Auto-select the first project once the list loads (unless the user is composing
  // a new project or already has a valid selection).
  useEffect(() => {
    if (selected === "new") return;
    const validProject = visibleProjects.some(p => p.id === selected);
    const validDraft = selected.startsWith("draft:") && drafts.some(([k]) => `draft:${k}` === selected);
    if (!validProject && !validDraft) {
      setSelected(visibleProjects[0]?.id ?? "new");
    }
  }, [visibleProjects, drafts, selected]);

  const repos = new Set(visibleProjects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? []));

  // Per-project live fleet counts (a worker belongs to a project when its repo matches).
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

  // ── actions ─────────────────────────────────────────────────────────────────
  function handleOpenGithubBoard(p: GhProject) {
    const r = p.repositories?.nodes?.map((x) => x.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, r[0] ?? "", p.number, r);
    setGithubTab("projects");
    setScreen("github");
    openGithubBoard("overview");
  }
  function handleEditPlan(p: GhProject) {
    const all = p.repositories?.nodes?.map((x) => x.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, all[0] ?? "", p.number, all);
    setPlanningContext(p.shortDescription ?? p.title, all[0] ?? "");
    setPlanningSession(p.title);
    setProjectsView("planning");
  }
  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    if (githubToken) {
      try {
        await invoke("github_graphql", { token: githubToken, query: DELETE_MUTATION, variables: { projectId: deleteTarget.id } });
      } catch (e) { console.warn(`github project delete failed (removing locally anyway): ${e}`); }
    }
    await invoke("delete_project_dir", { projectKey: deleteTarget.title }).catch((e) => console.warn(`delete_project_dir failed: ${e}`));
    deleteLocalProject([deleteTarget.title, deleteTarget.id]);
    dismissProject(deleteTarget.id);
    setProjects(prev => prev.filter(p => p.id !== deleteTarget.id));
    setDeleting(false);
    setDeleteTarget(null);
  }
  async function handleStartPlanning() {
    if (!titleTrimmed || titleConflict) return;
    const draftKey = sanitizeProjectKey(titleTrimmed);
    removeDraftProject(draftKey);
    deleteLocalProject([draftKey]);
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
    setSelected("new");
  }

  const selProject = visibleProjects.find(p => p.id === selected) ?? null;
  const selDraft = selected.startsWith("draft:") ? drafts.find(([k]) => `draft:${k}` === selected) : null;

  return (
    <section style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "18px 24px 14px" }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>Projects</h2>
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
            {visibleProjects.length} project{visibleProjects.length !== 1 ? "s" : ""}
            {repos.size > 0 ? ` across ${repos.size} repo${repos.size !== 1 ? "s" : ""}` : ""} · select to preview, open to dive in
            {lastSync && <> · last sync {timeAgo(lastSync.toISOString())}</>}
          </div>
        </div>
        <button className="btn ghost" onClick={fetchProjects} disabled={loading}>{loading ? "syncing…" : "↻ sync"}</button>
        <button className="btn" onClick={() => setScreen("github")}>import</button>
      </div>

      {error && (
        <div style={{
          margin: "0 24px 12px", padding: "12px 16px", borderRadius: 6,
          background: "color-mix(in oklch, var(--danger), transparent 88%)",
          border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
        }}>
          {error.includes("read:project")
            ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
            : error}
        </div>
      )}

      {/* master-detail */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "300px 1fr", gap: 14, padding: "0 24px 20px", minHeight: 0 }}>
        {/* master list */}
        <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 8px 8px" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", color: "var(--fg-dim)" }}>ALL · {visibleProjects.length}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setSelected("new")} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Plus size={12} /> new
            </button>
          </div>

          {loading && visibleProjects.length === 0 && (
            <div style={{ padding: "16px 10px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>Loading…</div>
          )}
          {!loading && visibleProjects.length === 0 && drafts.length === 0 && (
            <div style={{ padding: "16px 10px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>No projects yet. Click <b>+ new</b> to plan one.</div>
          )}

          {visibleProjects.map(p => (
            <MiniProjRow key={p.id} p={p} selected={selected === p.id} onSelect={() => setSelected(p.id)} />
          ))}

          {drafts.length > 0 && (
            <>
              <div style={{ height: 1, background: "var(--border-soft)", margin: "6px 8px" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", padding: "0 8px 2px" }}>
                {drafts.length} draft{drafts.length !== 1 ? "s" : ""} · not on GitHub
              </span>
              {drafts.map(([key, d]) => (
                <MiniDraftRow key={key} d={d} selected={selected === `draft:${key}`} onSelect={() => setSelected(`draft:${key}`)} />
              ))}
            </>
          )}
        </div>

        {/* detail pane */}
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto", padding: 18 }}>
          {selected === "new" ? (
            <PlanComposer
              title={title} setTitle={setTitle} pitch={pitch} setPitch={setPitch}
              titleConflict={!!titleConflict} canStart={!!titleTrimmed && !titleConflict}
              onStart={handleStartPlanning}
            />
          ) : selDraft ? (
            (() => {
              const [key, d] = selDraft;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="tag amber">draft</span>
                    <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 17, fontWeight: 600 }}>{d.title}</h2>
                    <span style={{ flex: 1 }} />
                    <button className="btn primary" onClick={() => reopenDraft(key, d)}>resume planning →</button>
                    <button className="btn danger" onClick={() => deleteDraft(key)} style={{ display: "flex", alignItems: "center", gap: 6 }}><Trash2 size={12} /> delete</button>
                  </div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.55 }}>{d.pitch || "No pitch yet."}</div>
                  <div className="hint">Not yet on GitHub — resume planning to define and publish it.</div>
                </div>
              );
            })()
          ) : selProject ? (
            <ProjectPreview
              p={selProject}
              fleet={fleetByProject[selProject.id] ?? { running: 0, paused: 0 }}
              menuOpen={menuOpen} setMenuOpen={setMenuOpen} menuRef={menuRef}
              onBoard={() => handleOpenGithubBoard(selProject)}
              onPlan={() => handleEditPlan(selProject)}
              onDelete={() => setDeleteTarget(selProject)}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              Select a project to preview.
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: "24px 28px", width: 420, maxWidth: "90vw" }}>
            <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>Delete project?</h3>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b> will be deleted from GitHub (if it still exists)
              and its local planning data removed. Linked issues and milestones are not deleted.
            </p>
            {deleteError && (
              <div style={{ padding: "8px 12px", borderRadius: 4, marginBottom: 14, background: "color-mix(in oklch, var(--danger), transparent 88%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{deleteError}</div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => { setDeleteTarget(null); setDeleteError(null); }} disabled={deleting}>cancel</button>
              <button className="btn danger" onClick={handleDeleteConfirm} disabled={deleting} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Trash2 size={12} />{deleting ? "deleting…" : "delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ── plan composer (the "+ new" detail) — the slim plan bar relocated ──────────
function PlanComposer({ title, setTitle, pitch, setPitch, titleConflict, canStart, onStart }: {
  title: string; setTitle: (v: string) => void; pitch: string; setPitch: (v: string) => void;
  titleConflict: boolean; canStart: boolean; onStart: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 26, height: 26, borderRadius: 6, background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))", color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>C</div>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Plan a new project</h2>
        <span className="tag amber" style={{ fontSize: 9.5 }}>creates milestones + issues on github</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ padding: "8px 14px", background: "var(--bg-canvas)", borderRadius: 8, border: "1px solid " + (titleConflict ? "var(--danger)" : "var(--border-soft)"), display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>title</span>
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Tab") e.preventDefault(); }} placeholder="project title…" autoFocus
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }} />
          {titleConflict && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>⚠ already exists</span>}
        </div>
        <div style={{ padding: "8px 14px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 13 }}>▸</span>
          <input value={pitch} onChange={e => setPitch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") onStart(); }} placeholder="describe what you want to build… (optional)"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }} />
          <button onClick={onStart} disabled={!canStart} className="btn primary" style={{ height: 26, fontSize: 11, opacity: canStart ? 1 : 0.4 }}>start planning →</button>
        </div>
      </div>
      <div className="hint">A dedicated planning session turns your pitch into a goal, scope, phases, granular issues, and an agent fleet — then publishes the structure to GitHub.</div>
    </div>
  );
}

// ── project preview (the detail pane) ────────────────────────────────────────
export function ProjectPreview({ p, fleet, menuOpen, setMenuOpen, menuRef, onBoard, onPlan, onDelete }: {
  p: GhProject; fleet: { running: number; paused: number };
  menuOpen: boolean; setMenuOpen: (v: boolean) => void; menuRef: React.RefObject<HTMLDivElement | null>;
  onBoard: () => void; onPlan: () => void; onDelete: () => void;
}) {
  const status = projStatus(p);
  const { open, closed, pct } = projectProgress(p);
  const repoNames = (p.repositories?.nodes ?? []).map(r => r.nameWithOwner);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ width: 9, height: 9, borderRadius: 99, background: STATUS_META[status].dot }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{p.number}</span>
        <h2 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 17, fontWeight: 600 }}>{p.title}</h2>
        <span className={"tag " + STATUS_META[status].cls} style={{ fontSize: 9.5 }}>{STATUS_META[status].label}</span>
        {repoNames.length === 1 && <span className="tag" style={{ fontSize: 9.5 }}>{repoNames[0].split("/")[1] ?? repoNames[0]}</span>}
        {repoNames.length > 1 && <span className="tag" style={{ fontSize: 9.5 }} title={repoNames.join("\n")}>{repoNames.length} repos</span>}
        <FleetPill running={fleet.running} paused={fleet.paused} />
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onPlan}>plan →</button>
        <button className="btn primary" onClick={onBoard} style={{ display: "flex", alignItems: "center", gap: 6 }}>open board <ExternalLink size={12} strokeWidth={2.2} /></button>
        <div ref={menuRef} style={{ position: "relative" }}>
          <button className="btn ghost" style={{ height: 28, width: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setMenuOpen(!menuOpen)} title="More options"><MoreHorizontal size={14} /></button>
          {menuOpen && (
            <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100, background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 168, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
              <button className="menu-item danger" onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={12} /> delete project</button>
            </div>
          )}
        </div>
      </div>

      <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.55 }}>{p.shortDescription ?? "No description."}</div>

      {/* KPIs (real) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        <Kpi label="items" value={String(p.items.totalCount)} />
        <Kpi label="done" value={`${Math.round(pct * 100)}%`} tone="var(--success)" />
        <Kpi label="open" value={String(open)} tone={open > 0 ? "var(--accent)" : undefined} />
        <Kpi label="repos" value={String(repoNames.length)} />
      </div>

      {/* progress (real) */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Item progress</h3>
          <span className="hint">closed / open of {open + closed} tracked</span>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden", marginBottom: 8 }}>
          <div style={{ height: "100%", width: `${pct * 100}%`, background: pct >= 1 ? "var(--success)" : "var(--accent)" }} />
        </div>
        <div style={{ display: "flex", gap: 18, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
          <span><b style={{ color: "var(--fg)" }}>{closed}</b> closed</span>
          <span><b style={{ color: "var(--fg)" }}>{open}</b> open</span>
          <span style={{ color: "var(--fg-dim)" }}>updated {timeAgo(p.updatedAt)}</span>
        </div>
      </div>

      {/* repos (real) */}
      {repoNames.length > 0 && (
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Repositories</h3>
            <span className="hint">{repoNames.length} linked</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {repoNames.map(r => (
              <div key={r} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--info)" }} />{r}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Milestones / burndown / recent-activity live on the board — honest, no fabricated charts. */}
      <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <span className="hint">Milestones, iteration burndown &amp; recent activity</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onBoard} style={{ display: "flex", alignItems: "center", gap: 6 }}>open board <ExternalLink size={12} /></button>
      </div>
    </div>
  );
}
