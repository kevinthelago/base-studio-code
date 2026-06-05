// Project Overview — the landing tab for an individual project (GitHub-rework #523,
// design Option A). A real "project home" that surfaces the project's repos, its
// live agent fleet, and coordination state, with quick-nav into the deep analytical
// tabs (Board · Roadmap · Issues · Insights). Burndown / milestones / recent-activity
// from the design live in those tabs — the Overview links to them rather than
// duplicating (or fabricating) their data.

import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { useAppStore } from "../../store";
import { useFleetLive } from "../../hooks/useFleetLive";
import { ProjectsHeader, type ActiveProjectInfo } from "./ProjectsHeader";
import type { WorkerStatus } from "../../data/fleet";

const STATUS_COLOR: Record<WorkerStatus, string> = {
  running: "var(--success)",
  asking:  "var(--accent)",
  blocked: "var(--danger)",
  waiting: "var(--accent)",
  idle:    "var(--fg-dim)",
  done:    "var(--info)",
};

function Card({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {hint && <span className="hint">{hint}</span>}
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </div>
  );
}

export function ProjectOverview() {
  const {
    activeProjectId, activeProjectName, activeProjectRepo, activeProjectRepos, activeProjectNumber,
    setGithubBoardTab,
  } = useAppStore();
  const { workers } = useFleetLive();

  const project: ActiveProjectInfo = {
    id: activeProjectId ?? "",
    number: activeProjectNumber,
    name: activeProjectName,
    repo: activeProjectRepo,
    repos: activeProjectRepos,
    description: "",
  };

  // Live workers belonging to this project (matched by repo).
  const projWorkers = useMemo(() => {
    const set = new Set(activeProjectRepos);
    return workers.filter(w => set.has(w.repo));
  }, [workers, activeProjectRepos]);
  const running = projWorkers.filter(w => w.status === "running").length;
  const parked = projWorkers.filter(w => w.status === "blocked" || w.status === "asking" || w.status === "waiting");

  const deepDives: Array<{ tab: "board" | "roadmap" | "issues" | "insights"; label: string; desc: string }> = [
    { tab: "insights", label: "Iteration burndown", desc: "velocity, burndown & cycle time" },
    { tab: "roadmap",  label: "Milestones",         desc: "phases over time" },
    { tab: "board",    label: "Recent activity",    desc: "the kanban board, per column" },
    { tab: "issues",   label: "All issues",         desc: "flat list · filter & sort" },
  ];

  return (
    <>
      <ProjectsHeader project={project} />
      <section style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "var(--bg-canvas)" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 14 }}>
          {/* left column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <Card title="Repositories" hint={`${activeProjectRepos.length} linked`}>
              {activeProjectRepos.length === 0 ? (
                <div className="hint">No repositories linked.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {activeProjectRepos.map(r => (
                    <div key={r} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--info)" }} />{r}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Project analytics" hint="open a deep view">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {deepDives.map(d => (
                  <div key={d.tab} onClick={() => setGithubBoardTab(d.tab)} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 6, cursor: "pointer",
                    border: "1px solid var(--border-soft)", background: "var(--bg-panel)",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{d.label}</div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>{d.desc}</div>
                    </div>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>
                      view <ExternalLink size={11} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* right column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <Card
              title="Agent fleet"
              hint={`${projWorkers.length} stream${projWorkers.length !== 1 ? "s" : ""}`}
              right={running > 0 ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--success)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--success)", animation: "pulse 1.4s ease-in-out infinite" }} />
                  {running} running
                </span>
              ) : undefined}
            >
              {projWorkers.length === 0 ? (
                <div className="hint">No live agents for this project. Start a fleet from planning.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {projWorkers.map(w => (
                    <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_COLOR[w.status] }} />
                      <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{w.name}</span>
                      <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>{w.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Coordination"
              hint="#199"
              right={parked.length > 0 ? <span className="tag amber" style={{ fontSize: 9.5 }}>{parked.length}</span> : undefined}
            >
              {parked.length === 0 ? (
                <div className="hint">No blocked or waiting sessions.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {parked.map(w => (
                    <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_COLOR[w.status] }} />
                      <span style={{ color: "var(--fg)" }}>{w.name}</span>
                      {w.note && <span style={{ color: "var(--fg-dim)", fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>· {w.note}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </section>
    </>
  );
}
