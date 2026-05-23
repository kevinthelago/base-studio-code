import { useAppStore } from "../../store";

export interface ActiveProjectInfo {
  id: string;
  number: number;
  name: string;
  repo: string;
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

      <div style={{
        height: 36, marginTop: 12,
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
