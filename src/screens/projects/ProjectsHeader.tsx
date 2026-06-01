import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { sanitizeProjectKey, projectRepoCwd } from "../../lib/projectPaths";

/** Mirror of the Rust sanitize_project_key: ASCII alnum/dash kept, else `_`, capped 80. */
const sanitizeKey = sanitizeProjectKey;

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
  { k: "hooks",    label: "Hooks",    hint: "git hooks · per repo" },
  { k: "coordination", label: "Coordination", hint: "blocked sessions · #199" },
  { k: "pipelines", label: "Pipelines", hint: "staged work-item lifecycle · #220" },
] as const;

type BoardTab = typeof TABS[number]["k"];

interface ProjectsHeaderProps {
  project: ActiveProjectInfo;
}

function RepoResolverStrip({ project }: { project: ActiveProjectInfo }) {
  const { projectLocalRepos, bscBaseDir } = useAppStore();
  const clonedNames = projectLocalRepos[project.id] ?? [];
  const [cloning, setCloning]     = useState<Set<string>>(new Set());
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded]   = useState(false);
  const cloningRef = useRef<Set<string>>(new Set());

  const multi = project.repos.length > 1;

  // Auto-clone every linked repo into the app-managed directory on first view.
  useEffect(() => {
    if (!project.id) return;
    const currentCloned = new Set(useAppStore.getState().projectLocalRepos[project.id] ?? []);
    const unresolved = project.repos.filter(
      r => !currentCloned.has(r) && !cloningRef.current.has(r)
    );
    for (const fullName of unresolved) {
      cloningRef.current.add(fullName);
      setCloning(s => new Set([...s, fullName]));
      invoke<string>("clone_repo", { project: project.name, fullName })
        .then(() => {
          useAppStore.getState().addProjectRepo(project.id, fullName);
        })
        .catch(e => setCloneErrors(prev => ({ ...prev, [fullName]: String(e) })))
        .finally(() => {
          cloningRef.current.delete(fullName);
          setCloning(s => { const n = new Set(s); n.delete(fullName); return n; });
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function handleClone(fullName: string) {
    setCloning((s) => new Set([...s, fullName]));
    setCloneErrors((e) => { const n = { ...e }; delete n[fullName]; return n; });
    try {
      await invoke<string>("clone_repo", { project: project.name, fullName });
      useAppStore.getState().addProjectRepo(project.id, fullName);
    } catch (e) {
      setCloneErrors((prev) => ({ ...prev, [fullName]: String(e) }));
    } finally {
      setCloning((s) => { const n = new Set(s); n.delete(fullName); return n; });
    }
  }

  if (project.repos.length === 0) return null;

  const resolvedCount  = project.repos.filter(r => clonedNames.includes(r)).length;
  const failedRepos    = project.repos.filter(r => !!cloneErrors[r] && !cloning.has(r));

  return (
    <div style={{
      padding: "5px 24px 0",
      fontFamily: "var(--mono)", fontSize: 10.5,
    }}>
      {/* Summary row — always visible */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: "var(--fg-dim)" }}>repos</span>

        {multi ? (
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              background: "none", border: "none", padding: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
            }}
          >
            <span style={{
              display: "inline-block", fontSize: 8, color: "var(--fg-dim)",
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s",
            }}>▼</span>
            <span>
              {project.repos.length} repositories
              {resolvedCount > 0 && (
                <span style={{ color: "var(--success)" }}> · {resolvedCount} cloned</span>
              )}
              {cloning.size > 0 && (
                <span style={{ color: "var(--accent)" }}> · cloning…</span>
              )}
            </span>
          </button>
        ) : (
          (() => {
            const fullName  = project.repos[0];
            const isCloned  = clonedNames.includes(fullName);
            const isCloning = cloning.has(fullName);
            const err       = cloneErrors[fullName];
            const localPath = projectRepoCwd(bscBaseDir, project.name, fullName);
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "var(--fg-muted)" }}>{fullName}</span>
                {isCloned ? (
                  <span title={localPath} style={{ color: "var(--success)", fontSize: 10 }}>
                    ● {fullName.split("/")[1]}
                  </span>
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
          })()
        )}

        {failedRepos.length > 0 && (
          <span
            onClick={() => failedRepos.forEach(r => handleClone(r))}
            style={{
              padding: "1px 8px", borderRadius: 3,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              color: "var(--danger)", cursor: "pointer", fontSize: 10,
              fontFamily: "var(--mono)",
            }}
          >retry failed →</span>
        )}
      </div>

      {/* Expanded repo list — multi only */}
      {multi && expanded && (
        <div style={{
          marginTop: 6, paddingLeft: 16,
          display: "flex", flexDirection: "column", gap: 5,
          borderLeft: "2px solid var(--border-soft)",
        }}>
          {project.repos.map((fullName) => {
            const isCloned  = clonedNames.includes(fullName);
            const isCloning = cloning.has(fullName);
            const err       = cloneErrors[fullName];
            const localPath = projectRepoCwd(bscBaseDir, project.name, fullName);
            return (
              <div key={fullName} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--fg-muted)" }}>{fullName}</span>
                {isCloned ? (
                  <span title={localPath} style={{ color: "var(--success)", fontSize: 10 }}>
                    ● {fullName.split("/")[1]}
                  </span>
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
        </div>
      )}
    </div>
  );
}

export function ProjectsHeader({ project }: ProjectsHeaderProps) {
  const { projectsBoardTab, setProjectsBoardTab, setProjectsView, setPlanningContext, setPlanningSession, setScreen, setKbProjectScope } = useAppStore();

  // Open the Knowledge Base scoped to this project's documents, keyed by the
  // canonical (title-derived) folder the planner writes to. We intentionally do
  // NOT reference the legacy node-id-keyed folder.
  function handleViewDocuments() {
    setKbProjectScope({ keys: [sanitizeKey(project.name)], label: project.name });
    setScreen("knowledge");
  }

  function handlePlan() {
    setPlanningContext(
      `I want to flesh out an existing GitHub Project #${project.number} called "${project.name}"${project.repo ? ` in ${project.repo}` : ""}. Help me define a clear goal, scope, tech stack, phases with milestones, and key risks. Then we'll publish milestones and tracking issues.`,
      project.repo,
    );
    // Key the session by the project name (stable, human-readable, and matches a
    // from-scratch session of the same name). The node id stays in activeProjectId.
    setPlanningSession(project.name);
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
          <button
            className="btn ghost"
            onClick={handleViewDocuments}
            title="View this project's documents in the Knowledge Base"
            style={{ fontFamily: "var(--mono)", fontSize: 11 }}
          >📄 documents</button>
          <button
            className="btn primary"
            onClick={handlePlan}
            style={{ fontFamily: "var(--mono)", fontSize: 11 }}
          >⌘ plan →</button>
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
      </div>
    </>
  );
}
