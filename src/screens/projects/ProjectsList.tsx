import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useAppStore } from "../../store";

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
  onOpen: (p: GhProject) => void;
  onEdit: (p: GhProject) => void;
  onDelete: (p: GhProject) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}

function ProjectRow({ p, onOpen, onEdit, onDelete, menuOpenId, setMenuOpenId }: ProjectRowProps) {
  const repo    = p.repositories?.nodes?.[0]?.nameWithOwner ?? "";
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen  = menuOpenId === p.id;

  return (
    <div className="card" style={{
      padding: "14px 18px",
      display: "grid", gridTemplateColumns: "1fr auto", gap: 18, alignItems: "center",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 5 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{p.number}</span>
          <h3 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 14, color: "var(--fg)" }}>{p.title}</h3>
          {p.closed
            ? <span className="tag" style={{ fontSize: 9.5 }}>● closed</span>
            : <span className="tag green" style={{ fontSize: 9.5 }}>● active</span>
          }
          {repo && <span className="tag" style={{ fontSize: 9.5 }}>{repo}</span>}
          <span style={{
            padding: "1px 6px", borderRadius: 3,
            fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--info)",
            background: "color-mix(in oklch, var(--info), transparent 88%)",
            border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
          }}>⎇ synced · gh/projects/{p.number}</span>
        </div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.55, marginBottom: 8 }}>
          {p.shortDescription ?? "No description."}
        </div>
        <div style={{ display: "flex", gap: 14, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", flexWrap: "wrap" }}>
          <span><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</span>
          {(p.repositories?.nodes?.length ?? 0) > 1 && (
            <span>· {p.repositories.nodes.length} repos</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginRight: 4 }}>
          {timeAgo(p.updatedAt)}
        </span>
        <button
          className="btn primary"
          style={{ height: 28, fontSize: 10.5, padding: "0 12px", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}
          onClick={() => onOpen(p)}
        >
          open board <ExternalLink size={12} strokeWidth={2.2} />
        </button>

        {/* ⋯ menu */}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            className="btn ghost"
            style={{ height: 28, width: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : p.id)}
            title="More options"
          >
            <MoreHorizontal size={14} />
          </button>

          {isOpen && (
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 160,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}>
              <button
                className="menu-item"
                onClick={() => { setMenuOpenId(null); onEdit(p); }}
              >
                <Pencil size={12} /> plan / edit
              </button>
              <div style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              <button
                className="menu-item danger"
                onClick={() => { setMenuOpenId(null); onDelete(p); }}
              >
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
  const { githubToken, activeScreen, setProjectsView, setActiveProjectMeta, setPlanningContext, setPlanningTitle, setPlanningSession, deleteLocalProject } = useAppStore();
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

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    function handleClick() { setMenuOpenId(null); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpenId]);

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

  function handleOpenBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo  = repos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, repos);
    setProjectsView("board");
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
    setProjects(prev => prev.filter(p => p.id !== deleteTarget.id));
    setDeleting(false);
    setDeleteTarget(null);
  }

  const titleTrimmed = title.trim();
  const titleConflict = titleTrimmed
    ? projects.find(p => p.title.toLowerCase() === titleTrimmed.toLowerCase()) ?? null
    : null;

  function handleStartPlanning() {
    if (!titleTrimmed) return;
    setPlanningTitle(titleTrimmed);
    setPlanningContext(pitch.trim(), "");
    setActiveProjectMeta(null, "", "", 0);
    // New project: freeze the human-readable title as the session key so the
    // directory stays put even after publish assigns a GitHub Project id.
    setPlanningSession(titleTrimmed);
    setProjectsView("planning");
  }

  const repos = new Set(projects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? []));

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "24px 32px", minWidth: 0 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>Projects</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--success)" }}>● github connected</span>
              {!loading && projects.length > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {projects.length} project{projects.length !== 1 ? "s" : ""}
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

        {loading && projects.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
            Loading projects…
          </div>
        )}

        {!loading && projects.length === 0 && !error && (
          <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
            No GitHub Projects found. Create one at github.com/your-org to get started.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {projects.map(p => (
            <ProjectRow
              key={p.id}
              p={p}
              onOpen={handleOpenBoard}
              onEdit={handleEditPlan}
              onDelete={setDeleteTarget}
              menuOpenId={menuOpenId}
              setMenuOpenId={setMenuOpenId}
            />
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
