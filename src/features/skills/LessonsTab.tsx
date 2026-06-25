// The "Pending lessons" review queue (#1362) — a tab in the Skills screen. Self-correction candidates
// an agent captured with `bsc-learned` (mistake → cause → rule) land in the active project's plan.db;
// here the USER reviews them and confirms one into a project-scoped skill or discards it. Only the
// user advances a lesson — mirroring the platform's "only the user confirms" posture. A confirmed
// lesson becomes a `review`-kind skill scoped to the project (globalize it later via the normal
// skill-scope UI, the #1338 promote path).

import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/store";
import {
  loadPendingLessons, confirmLesson, discardLesson, lessonToSkill, type Lesson,
} from "./lib/lessons";

/** One reviewable candidate, with inline edit of the mistake/rule before it's confirmed into a skill. */
function LessonCard({ lesson, projectKey, onResolved }: { lesson: Lesson; projectKey: string; onResolved: () => void }) {
  const upsertSkills = useAppStore((s) => s.upsertSkills);
  const [editing, setEditing] = useState(false);
  const [mistake, setMistake] = useState(lesson.mistake);
  const [rule, setRule] = useState(lesson.rule);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback(async () => {
    setBusy(true);
    // Build the project skill from the (possibly edited) text, then record the verdict.
    const skill = lessonToSkill({ ...lesson, mistake, rule }, projectKey);
    if (skill) upsertSkills([skill]);
    await confirmLesson(projectKey, lesson.id);
    onResolved();
  }, [lesson, mistake, rule, projectKey, upsertSkills, onResolved]);

  const discard = useCallback(async () => {
    setBusy(true);
    await discardLesson(projectKey, lesson.id);
    onResolved();
  }, [lesson.id, projectKey, onResolved]);

  return (
    <div style={{ border: "1px solid var(--border-soft)", borderRadius: 6, padding: "10px 12px", background: "var(--bg-elev)", display: "grid", gap: 8 }}>
      {editing ? (
        <>
          <input className="input" value={mistake} onChange={(e) => setMistake(e.target.value)} placeholder="what went wrong" style={{ fontSize: 12 }} />
          <input className="input" value={rule} onChange={(e) => setRule(e.target.value)} placeholder="the corrective rule" style={{ fontSize: 12 }} />
        </>
      ) : (
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{mistake || <span className="hint">(no mistake)</span>}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)" }}>→ {rule || <span className="hint">(no rule)</span>}</span>
          {lesson.cause.trim() && <span className="hint" style={{ fontSize: 11 }}>{lesson.cause}</span>}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        {lesson.seen > 1 && <span className="pill" style={{ background: "var(--bg-panel)", color: "var(--fg-muted)" }}>seen ×{lesson.seen}</span>}
        {lesson.provenance && <span className="hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lesson.provenance}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" disabled={busy} onClick={() => setEditing((e) => !e)}>{editing ? "done editing" : "edit"}</button>
        <button className="btn ghost" disabled={busy} onClick={discard}>discard</button>
        <button className="btn" disabled={busy} onClick={confirm}>confirm</button>
      </div>
    </div>
  );
}

/** The pending-lessons queue for the active project. `projectKey` empty ⇒ a prompt to pick a project. */
export function LessonsTab({ projectKey, projectName }: { projectKey: string; projectName?: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!projectKey) { setLessons([]); return; }
    setLoading(true);
    void loadPendingLessons(projectKey).then((ls) => { setLessons(ls); setLoading(false); });
  }, [projectKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <section className="an-page"><div className="an-wrap">
      <h2 style={{ margin: "0 0 4px", fontFamily: "var(--mono)", fontSize: 18 }}>Pending lessons</h2>
      <div style={{ color: "var(--fg-muted)", fontSize: 12, marginBottom: 14 }}>
        Mistakes agents caught with <code>bsc-learned</code>{projectName ? <> in <b>{projectName}</b></> : null} — confirm one into a project skill, or discard it. Only you confirm.
      </div>

      {!projectKey ? (
        <div className="empty"><h3 style={{ margin: 0 }}>No active project</h3><p className="hint" style={{ maxWidth: 440, margin: 0 }}>Open a project to review the lessons its agents have captured. Lessons are scoped to the project that produced them.</p></div>
      ) : loading ? (
        <div className="hint">Loading…</div>
      ) : lessons.length === 0 ? (
        <div className="empty"><h3 style={{ margin: 0 }}>Nothing to review</h3><p className="hint" style={{ maxWidth: 440, margin: 0 }}>When an agent catches a mistake it runs <code>bsc-learned "&lt;what&gt;" --rule "&lt;fix&gt;"</code> and the candidate lands here for you to confirm. Recurring captures bump a "seen" counter instead of piling up.</p></div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {lessons.map((l) => <LessonCard key={l.id} lesson={l} projectKey={projectKey} onResolved={refresh} />)}
        </div>
      )}
    </div></section>
  );
}
