// The "Pending lessons" review queue (#1362) — a tab in the Skills screen. Self-correction candidates
// an agent captured with `bsc-learned` (mistake → cause → rule) land in the active project's plan.db;
// here the USER reviews them and confirms one into a project-scoped skill or discards it. Only the
// user advances a lesson — mirroring the platform's "only the user confirms" posture. A confirmed
// lesson becomes a `review`-kind skill scoped to the project (globalize it later via the normal
// skill-scope UI, the #1338 promote path).

import { useState, useEffect, useCallback } from "react";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import { Box } from "@/shared/ui/layout/Box";
import { Grid } from "@/shared/ui/layout/Grid";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { useAppStore } from "@/store";
import {
  loadPendingLessons, confirmLesson, discardLesson, lessonToSkill, type Lesson,
} from "./lib/lessons";

/** A loading placeholder shaped like a {@link LessonCard} — two text lines + a trailing action row (#2245). */
function LessonSkeleton() {
  return (
    <Grid gap={8} style={{ border: "1px solid var(--border-soft)", borderRadius: 6, padding: "10px 12px", background: "var(--bg-elev)" }}>
      <Skeleton h={13} w="72%" />
      <Skeleton h={12} w="54%" />
      <Row gap={8}><Box as="span" style={{ flex: 1 }} /><Skeleton w={56} h={22} /><Skeleton w={56} h={22} /></Row>
    </Grid>
  );
}

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
    <Grid gap={8} style={{ border: "1px solid var(--border-soft)", borderRadius: 6, padding: "10px 12px", background: "var(--bg-elev)" }}>
      {editing ? (
        <>
          <TextField value={mistake} onChange={setMistake} placeholder="what went wrong" style={{ fontSize: 12 }} />
          <TextField value={rule} onChange={setRule} placeholder="the corrective rule" style={{ fontSize: 12 }} />
        </>
      ) : (
        <Grid gap={3}>
          <Box as="span" className="mono-value">{mistake || <Box as="span" className="hint">(no mistake)</Box>}</Box>
          <Text as="span" mono size={12} tone="accent">→ {rule || <Box as="span" className="hint">(no rule)</Box>}</Text>
          {lesson.cause.trim() && <Text as="span" className="hint" size={11}>{lesson.cause}</Text>}
        </Grid>
      )}
      <Row gap={8} style={{ fontSize: 11 }}>
        {lesson.seen > 1 && <Box as="span" className="pill" bg="var(--bg-panel)" style={{ color: "var(--fg-muted)" }}>seen ×{lesson.seen}</Box>}
        {lesson.provenance && <Box as="span" className="hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lesson.provenance}</Box>}
        <Box as="span" style={{ flex: 1 }} />
        <Button variant="ghost" disabled={busy} onClick={() => setEditing((e) => !e)}>{editing ? "done editing" : "edit"}</Button>
        <Button variant="ghost" disabled={busy} onClick={discard}>discard</Button>
        <Button disabled={busy} onClick={confirm}>confirm</Button>
      </Row>
    </Grid>
  );
}

/** The pending-lessons queue for the active project. `projectKey` empty ⇒ a prompt to pick a project. */
export function LessonsTab({ projectKey, projectName }: { projectKey: string; projectName?: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  // Start loading when there's a project to fetch, so the first paint shows skeletons rather than a
  // one-frame "Nothing to review" flash before the effect fires the fetch (#2245).
  const [loading, setLoading] = useState(!!projectKey);

  const refresh = useCallback(() => {
    if (!projectKey) { setLessons([]); return; }
    setLoading(true);
    void loadPendingLessons(projectKey).then((ls) => { setLessons(ls); setLoading(false); });
  }, [projectKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <Box as="section" className="an-page"><Box className="an-wrap">
      <Text as="h2" mono size="xl" style={{ margin: "0 0 4px" }}>Pending lessons</Text>
      <Text as="div" tone="muted" size={12} style={{ marginBottom: 14 }}>
        Mistakes agents caught with <code>bsc-learned</code>{projectName ? <> in <b>{projectName}</b></> : null} — confirm one into a project skill, or discard it. Only you confirm.
      </Text>

      {!projectKey ? (
        <EmptyState title="No active project" description="Open a project to review the lessons its agents have captured. Lessons are scoped to the project that produced them." />
      ) : loading ? (
        <Grid gap={10}>{Array.from({ length: 3 }).map((_, i) => <LessonSkeleton key={i} />)}</Grid>
      ) : lessons.length === 0 ? (
        <EmptyState title="Nothing to review" description={<>When an agent catches a mistake it runs <code>bsc-learned "&lt;what&gt;" --rule "&lt;fix&gt;"</code> and the candidate lands here for you to confirm. Recurring captures bump a "seen" counter instead of piling up.</>} />
      ) : (
        <Grid gap={10}>
          {lessons.map((l) => <LessonCard key={l.id} lesson={l} projectKey={projectKey} onResolved={refresh} />)}
        </Grid>
      )}
    </Box></Box>
  );
}
