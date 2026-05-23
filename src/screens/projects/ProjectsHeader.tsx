import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { ResolvedRepo } from "../../store";

export interface ActiveProjectInfo {
  id: string;
  number: number;
  name: string;
  repo: string;
  repos: string[];
  description: string;
}

const TABS = [
  { k: "board",    label: "Board",    hint: "kanban · per column" },
  { k: "roadmap",  label: "Roadmap",  hint: "milestones over time" },
  { k: "issues",   label: "Issues",   hint: "flat list · filter & sort" },
  { k: "insights", label: "Insights", hint: "velocity · burndown" },
] as const;

type BoardTab = typeof TABS[number]["k"];

interface ProjectsHeaderProps {
  project: ActiveProjectInfo;
}

function RepoResolverStrip({ project }: { project: ActiveProjectInfo }) {
  const { projectLocalRepos, addProjectLocalRepo, quickStartProject } = useAppStore();
  const resolved = projectLocalRepos[project.id] ?? [];
  const [searching, setSearching] = useState<Set<string>>(new Set());
  const [cloning, setCloning]     = useState<Set<string>>(new Set());
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!project.id) return;
    const unresolved = project.repos.filter(
      (r) => !resolved.some((lr) => lr.full_name === r),
    );
    for (const fullName of unresolved) {
      setSearching((s) => new Set([...s, fullName]));
      invoke<string | null>("find_local_repo", { fullName })
        .then((path) => {
          if (path) addProjectLocalRepo(project.id, { full_name: fullName, local_path: path, source: "found" });
        })
        .catch(console.error)
        .finally(() =>
          setSearching((s) => { const n = new Set(s); n.delete(fullName); return n; }),
        );
    }
  // Re-run when the active project changes, not on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function handleClone(fullName: string) {
    setCloning((s) => new Set([...s, fullName]));
    setCloneErrors((e) => { const n = { ...e }; delete n[fullName]; return n; });
    try {
      const path = await invoke<string>("clone_repo", { fullName });
      addProjectLocalRepo(project.id, { full_name: fullName, local_path: path, source: "cloned" });
    } catch (e) {
      setCloneErrors((prev) => ({ ...prev, [fullName]: String(e) }));
    } finally {
      setCloning((s) => { const n = new Set(s); n.delete(fullName); return n; });
    }
  }

  if (project.repos.length === 0) return null;

  const resolvedForProject = resolved.filter((r) => project.repos.includes(r.full_name));
  const hasAnyResolved = resolvedForProject.length > 0;

  return (
    <div style={{
      padding: "5px 24px 0",
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      fontFamily: "var(--mono)", fontSize: 10.5,
    }}>
      <span style={{ color: "var(--fg-dim)" }}>repos</span>
      {project.repos.map((fullName) => {
        const r = resolved.find((lr) => lr.full_name === fullName);
        const isSearching = searching.has(fullName);
        const isCloning   = cloning.has(fullName);
        const err         = cloneErrors[fullName];
        return (
          <div key={fullName} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--fg-muted)" }}>{fullName}</span>
            {r ? (
              <span title={r.local_path} style={{ color: "var(--success)", fontSize: 10 }}>
                ● {r.local_path.split(/[\\/]/).pop()}
                {r.source === "cloned" && <span style={{ color: "var(--fg-dim)" }}> cloned</span>}
              </span>
            ) : isSearching ? (
              <span style={{ color: "var(--fg-dim)" }}>searching…</span>
            ) : isCloning ? (
              <span style={{ color: "var(--accent)" }}>cloning…</span>
            ) : (
              <span
                onClick={() => handleClone(fullName)}
                style={{
                  padding: "1px 6px", borderRadius: 3,
                  background: "var(--bg-elev)", border: "1px solid var(--border)",
                  color: err ? "var(--danger)" : "var(--fg-muted)",
                  cursor: "pointer", fontSize: 10,
                }}
              >{err ? "retry clone" : "clone →"}</span>
            )}
          </div>
        );
      })}
      {hasAnyResolved && (
        <button
          className="btn primary"
          style={{ height: 22, padding: "0 10px", fontSize: 10, marginLeft: "auto" }}
          onClick={() => quickStartProject(project.name, resolvedForProject as ResolvedRepo[])}
        >
          ⚡ quick start →
        </button>
      )}
    </div>
  );
}

export function ProjectsHeader({ project }: ProjectsHeaderProps) {
  const { projectsBoardTab, setProjectsBoardTab, setProjectsView, setPlanningContext } = useAppStore();

  function handlePlan() {
    setPlanningContext(
      `I want to flesh out an existing GitHub Project #${project.number} called "${project.name}"${project.repo ? ` in ${project.repo}` : ""}. Help me define a clear goal, scope, tech stack, phases with milestones, and key risks. Then we'll publish milestones and tracking issues.`,
      project.repo,
    );
    setProjectsView("planning");
  }

  return (
    <>
      <div style={{ padding: "14px 24px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <button
              onClick={() => setProjectsView("list")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                padding: 0, marginRight: 4,
              }}
            >← projects</button>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{project.number}</span>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>{project.name}</h2>
            {project.repo && <span className="tag">{project.repo}</span>}
            {project.number > 0 && (
              <span style={{
                padding: "1px 6px", borderRadius: 3,
                fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--info)",
                background: "color-mix(in oklch, var(--info), transparent 88%)",
                border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
              }}>⎇ synced w/ {project.repo}/projects/{project.number}</span>
            )}
          </div>
          {project.description && (
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{project.description}</div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="input" placeholder="⌕ filter…" style={{ width: 200 }} />
          <button className="btn ghost">claude triage</button>
          <button className="btn ghost" onClick={handlePlan} style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
            ⌘ plan →
          </button>
          <button className="btn">+ issue</button>
        </div>
      </div>

      <RepoResolverStrip project={project} />

      <div style={{
        height: 36, marginTop: 8,
        borderBottom: "1px solid var(--border-soft)",
        padding: "0 24px",
        display: "flex", alignItems: "end", gap: 2,
      }}>
        {TABS.map((t) => {
          const on = t.k === projectsBoardTab;
          return (
            <div
              key={t.k}
              onClick={() => setProjectsBoardTab(t.k as BoardTab)}
              style={{
                padding: "0 14px", height: 30,
                display: "flex", alignItems: "center", gap: 8,
                borderTopLeftRadius: 6, borderTopRightRadius: 6,
                background: on ? "var(--bg-canvas)" : "transparent",
                border: "1px solid " + (on ? "var(--border-soft)" : "transparent"),
                borderBottom: "0",
                color: on ? "var(--fg)" : "var(--fg-muted)",
                fontFamily: "var(--mono)", fontSize: 11.5,
                cursor: "pointer",
              }}
            >
              {t.label}
              {on && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>· {t.hint}</span>}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <div style={{
          display: "flex", gap: 6, alignSelf: "center", paddingBottom: 6,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        }}>
          group by · <span style={{ color: "var(--accent)", cursor: "pointer" }}>status</span> ·
          <span style={{ cursor: "pointer" }}>assignee</span> ·
          <span style={{ cursor: "pointer" }}>milestone</span>
        </div>
      </div>
    </>
  );
}
