// Pipelines lane (#220): a per-item view of each in-flight pipeline run -- which stage it
// is in, its status, and the stage sequence with attempt counts. You can start a run from
// a preset here (register-only for now); launching the stage as a role-scoped pane and
// auto-advancing on #199 events is the live-wiring slice.
import { useState } from "react";
import { useAppStore } from "../../store";
import { PIPELINE_PRESETS } from "../../lib/pipeline";
import { ProjectsHeader, useActiveProjectInfo } from "./ProjectsHeader";

function statusColor(status: string): string {
  return status === "done" ? "var(--success)" : status === "escalated" ? "var(--danger)" : "var(--accent)";
}

export function PipelinesLane() {
  const runs = useAppStore((s) => s.pipelineRuns);
  const start = useAppStore((s) => s.pipelineStart);
  const clear = useAppStore((s) => s.pipelineClear);
  const presetKeys = Object.keys(PIPELINE_PRESETS);
  const [preset, setPreset] = useState(presetKeys[0]);
  const [item, setItem] = useState("");

  const entries = Object.entries(runs);
  const project = useActiveProjectInfo();

  return (
    <>
    <ProjectsHeader project={project} />
    <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Pipelines</h2>
        <span className="hint">role-staged work-item lifecycle (#220)</span>
        <div style={{ flex: 1 }} />
        {entries.length > 0 && <span className="tag">{entries.length} active</span>}
      </div>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ height: 28, fontSize: 11 }}>
          {presetKeys.map((k) => (
            <option key={k} value={k}>{PIPELINE_PRESETS[k].name}</option>
          ))}
        </select>
        <input
          className="input"
          placeholder="work item (e.g. #42)"
          value={item}
          onChange={(e) => setItem(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && item.trim()) { start(preset, item.trim()); setItem(""); } }}
          style={{ height: 28, fontSize: 11, width: 180, fontFamily: "var(--mono)" }}
        />
        <button
          className="btn primary"
          style={{ height: 28, fontSize: 11 }}
          disabled={!item.trim()}
          onClick={() => { start(preset, item.trim()); setItem(""); }}
        >
          Start
        </button>
      </div>

      {entries.length === 0 && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 0" }}>
          No pipeline runs. Start one above — it flows a work item through its stages
          (implement → build &amp; test → review → integrate), each a role-scoped session.
        </div>
      )}

      {entries.map(([id, run]) => {
        const stages = Object.values(run.pipeline.stages);
        return (
          <div key={id} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{id}</h3>
              <span className="hint" style={{ fontSize: 10.5 }}>{run.pipeline.name}</span>
              <span className="tag" style={{ color: statusColor(run.state.status), fontSize: 9.5 }}>● {run.state.status}</span>
              <div style={{ flex: 1 }} />
              {run.state.escalation && (
                <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{run.state.escalation}</span>
              )}
              <button className="btn ghost" style={{ height: 22, fontSize: 10.5 }} onClick={() => clear(id)}>clear</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {stages.map((st, i) => {
                const current = run.state.stage === st.name;
                const attempts = run.state.attempts[st.name] ?? 0;
                return (
                  <span key={st.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {i > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 }}>→</span>}
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 5,
                      border: "1px solid " + (current ? "var(--accent)" : "var(--border-soft)"),
                      color: current ? "var(--accent)" : "var(--fg-muted)",
                      background: current ? "var(--bg-elev)" : "transparent",
                    }}>
                      {st.name} <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{st.role}</span>{attempts > 1 ? ` ×${attempts}` : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
    </>
  );
}
