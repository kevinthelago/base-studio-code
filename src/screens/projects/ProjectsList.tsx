import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { GithubRepo } from "../../store";

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
        repositories(first: 3) { nodes { nameWithOwner } }
      }
    }
  }
}`;

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TEMPLATES = ["bug fix", "new feature", "tech-debt", "spike", "migration", "runbook"];

function ProjectRow({ p, onOpen }: { p: GhProject; onOpen: (p: GhProject) => void }) {
  const repo = p.repositories.nodes[0]?.nameWithOwner ?? "";

  return (
    <div className="card" style={{
      padding: "14px 18px",
      display: "grid", gridTemplateColumns: "1fr 220px 130px", gap: 18, alignItems: "center",
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
          {p.repositories.nodes.length > 1 && (
            <span>· {p.repositories.nodes.length} repos</span>
          )}
        </div>
      </div>

      {/* Spacer for the middle column */}
      <div />

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          {timeAgo(p.updatedAt)}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn primary"
            style={{ height: 24, fontSize: 10.5 }}
            onClick={() => onOpen(p)}
          >open board →</button>
          <button className="btn ghost" style={{ height: 24, padding: "0 8px", fontSize: 10.5 }}>⋯</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsList() {
  const { githubToken, githubRepos, setProjectsView, setActiveProjectMeta, setPlanningContext } = useAppStore();
  const [projects, setProjects] = useState<GhProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [pitch, setPitch] = useState("");
  const [planRepo, setPlanRepo] = useState("");

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

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  function handleOpenBoard(p: GhProject) {
    const repos = p.repositories.nodes.map((r) => r.nameWithOwner);
    const repo = repos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, repos);
    setProjectsView("board");
  }

  function handleStartPlanning() {
    if (!pitch.trim()) return;
    setPlanningContext(pitch.trim(), planRepo);
    setActiveProjectMeta(null, "", "", 0);
    setProjectsView("planning");
  }

  const repos = new Set(projects.flatMap(p => p.repositories.nodes.map(r => r.nameWithOwner)));

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
          padding: "22px 24px",
          marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 7,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>C</div>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14 }}>Plan a new project</h3>
            <span className="tag amber" style={{ fontSize: 10 }}>publishes to github when ready</span>
            <div style={{ flex: 1 }} />
            <span className="hint">avg session: ~12 questions, 8 min → milestone + issues</span>
          </div>
          <div style={{
            padding: "12px 14px",
            background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8,
            display: "flex", alignItems: "center", gap: 10,
            fontFamily: "var(--mono)", fontSize: 12,
          }}>
            <span style={{ color: "var(--accent)" }}>▸</span>
            <input
              value={pitch}
              onChange={e => setPitch(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); }}
              placeholder="pitch what you want to build…"
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
              }}
            />
            <span
              onClick={handleStartPlanning}
              style={{
                padding: "3px 10px", borderRadius: 4,
                background: pitch.trim() ? "var(--accent)" : "var(--bg-elev)",
                color: pitch.trim() ? "#1a120a" : "var(--fg-dim)",
                fontWeight: 600, fontSize: 11,
                cursor: pitch.trim() ? "pointer" : "default",
              }}
            >↵ start planning</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
            <span style={{ color: "var(--fg-dim)" }}>target repo:</span>
            <select
              value={planRepo}
              onChange={e => setPlanRepo(e.target.value)}
              style={{
                background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                borderRadius: 4, padding: "2px 6px",
                fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)",
                cursor: "pointer",
              }}
            >
              <option value="">— select repo —</option>
              {githubRepos.map((r: GithubRepo) => (
                <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
              ))}
            </select>
            <span style={{ color: "var(--border-soft)" }}>·</span>
            <span style={{ color: "var(--fg-muted)" }}>from template:</span>
            {TEMPLATES.map(t => (
              <span
                key={t}
                onClick={() => setPitch(t)}
                style={{
                  padding: "2px 7px", borderRadius: 99,
                  background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                  color: "var(--fg-muted)", cursor: "pointer",
                }}
              >{t}</span>
            ))}
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
          {projects.map(p => <ProjectRow key={p.id} p={p} onOpen={handleOpenBoard} />)}
        </div>
      </div>
    </section>
  );
}
