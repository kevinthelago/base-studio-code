// Grade report-card pipeline screen (#615 slice b). Renders the GradeResult(s) for the
// current section — overall letter/score, per-dimension bars, and findings. A section
// can carry MULTIPLE graders, shown as tabs. A "Grade" action runs the section's rubric
// grader on its content. Mirrors render-preview/file-intake: planner chrome via
// PipelineScreenFrame, state from the store.

import { useState } from "react";
import { PipelineScreenFrame } from "./PipelineScreenFrame";
import { useAppStore } from "@/store";
import { resolveLlmConfig, hasLlmKey } from "@/shared/lib/core/llmConfig";
import { runSectionGrade } from "./gradeDispatch";
import { runSectionGradeLLM } from "./gradeLLM";
import type { GradeResult, Severity } from "./grading";
import type { PipelineScreenProps } from "./pipelineScreens";
import { letterColor, gradeColor } from "@/features/planner/lib/planGrade";

const EMPTY: GradeResult[] = [];

// Grade colors come from the one shared map (#686) so chips + bars agree across every
// surface. GradeResult scores are 0..100 → divide for the 0..1 gradeColor.
const scoreColor = (n: number): string => gradeColor(n / 100);
const sevColor = (s: Severity): string => (s === "error" ? "var(--danger)" : s === "warn" ? "var(--accent)" : "var(--fg-muted)");

function GradeCard({ g }: { g: GradeResult }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* overall */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 46, height: 46, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 22, color: letterColor(g.letter), background: "color-mix(in oklch, " + letterColor(g.letter) + ", transparent 88%)", border: "1px solid color-mix(in oklch, " + letterColor(g.letter) + ", transparent 70%)" }}>{g.letter}</div>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>{g.score}<span style={{ color: "var(--fg-dim)", fontSize: 11 }}>/100</span></div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{g.graderLabel}</div>
        </div>
      </div>

      {/* dimensions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {g.dimensions.map((d) => (
          <div key={d.id}>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", marginBottom: 2 }}>
              <span>{d.label}</span><span style={{ color: scoreColor(d.score) }}>{d.score}</span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-canvas)", overflow: "hidden" }}>
              <div style={{ width: `${d.score}%`, height: "100%", background: scoreColor(d.score) }} />
            </div>
          </div>
        ))}
      </div>

      {/* findings */}
      {g.findings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="ulabel" style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--fg-dim)" }}>findings · {g.findings.length}</div>
          {g.findings.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 7, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              <span style={{ color: sevColor(f.severity) }}>{f.severity === "error" ? "✗" : f.severity === "warn" ? "▲" : "·"}</span>
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GradeReportPane({ projectKey, sectionKey, sectionContent, onClose }: PipelineScreenProps) {
  const grades = useAppStore((s) => (sectionKey ? s.sectionGrades[projectKey]?.[sectionKey] : undefined)) ?? EMPTY;
  const hasKey = useAppStore((s) => hasLlmKey(resolveLlmConfig(s)));
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState<null | "rubric" | "llm">(null);
  const [err, setErr] = useState<string | null>(null);
  const active = grades[Math.min(tab, Math.max(0, grades.length - 1))];

  const grade = () => { if (sectionKey) runSectionGrade({ projectKey, sectionKey, content: sectionContent }); };
  const claudeReview = async () => {
    if (!sectionKey) return;
    setBusy("llm"); setErr(null);
    try { await runSectionGradeLLM({ projectKey, sectionKey, content: sectionContent, llm: resolveLlmConfig(useAppStore.getState()) }); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  };

  return (
    <PipelineScreenFrame
      label="grade"
      statusLabel={active ? `${active.letter} · ${active.score}` : "not graded"}
      statusColor={active ? letterColor(active.letter) : "var(--fg-dim)"}
      actions={
        <>
          <button className="btn ghost sm" onClick={grade} disabled={!sectionKey} title="Run the section's rubric grader">Grade</button>
          <button className="btn ghost sm" onClick={() => void claudeReview()} disabled={!sectionKey || busy === "llm" || !hasKey}
            title={hasKey ? "Ask the LLM to review this section" : "Add an API key in Settings → Integrations"}>
            {busy === "llm" ? "Reviewing…" : "✦ Claude"}
          </button>
        </>
      }
      onClose={onClose}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 12, overflow: "auto" }}>
        {err && <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 10.5 }}>{err}</div>}
        {grades.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 11, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>No grade yet for this section.</div>
            <button className="btn primary sm" style={{ alignSelf: "center" }} onClick={grade} disabled={!sectionKey}>Grade this section</button>
          </div>
        ) : (
          <>
            {grades.length > 1 && (
              <div className="seg" style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: 99, overflow: "hidden", alignSelf: "flex-start" }}>
                {grades.map((g, i) => (
                  <button key={g.graderId} className={i === tab ? "on" : ""} onClick={() => setTab(i)}
                    style={{ border: 0, background: i === tab ? "var(--bg-elev2)" : "transparent", color: i === tab ? "var(--fg)" : "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 9.5, padding: "3px 9px", cursor: "pointer" }}>
                    {g.letter} {g.graderLabel.replace(/ rubric$/i, "")}
                  </button>
                ))}
              </div>
            )}
            {active && <GradeCard g={active} />}
          </>
        )}
      </div>
    </PipelineScreenFrame>
  );
}
