// Self-correction lessons — the frontend side of #1362. A lesson is a mistake an agent caught
// mid-session (captured by the `bsc-learned` helper into the project's plan.db); the user reviews the
// pending queue here and confirms it into a project skill or discards it. The Tauri commands
// (`plan_lesson_*`, in src-tauri/src/project/plan_db.rs) are thin wrappers over the plandb crate.
//
// Kept Tauri-light + React-free so the mapping helpers are unit-testable; the LessonsTab component
// does the rendering. Mirrors how skillBridge.ts isolates the skilldb bridge.

import { invoke } from "@tauri-apps/api/core";
import { blankSkill, skillSlug, type SkillDef } from "./skills";

/** A captured lesson candidate — mirrors the Rust `plandb::Lesson` (camelCase). */
export interface Lesson {
  id: string;
  /** What went wrong. */
  mistake: string;
  /** Why it happened (optional). */
  cause: string;
  /** The corrective rule a future agent should follow. */
  rule: string;
  /** Origin tag set by the capture helper (`pane …, repo …`). */
  provenance: string;
  /** `pending` | `confirmed` | `discarded`. */
  status: string;
  /** How many times this same lesson was captured (dedup counter). */
  seen: number;
  createdAt: number;
  updatedAt: number;
}

/** The project's pending lesson candidates (the review queue). Returns [] when the bridge is absent
 *  (no Tauri host / no plan.db) so the UI degrades to an empty queue rather than throwing. */
export async function loadPendingLessons(projectKey: string): Promise<Lesson[]> {
  if (!projectKey) return [];
  try {
    return (await invoke<Lesson[]>("plan_lesson_list", { projectKey, status: "pending" })) ?? [];
  } catch {
    return [];
  }
}

/** Mark a candidate confirmed (the user accepted it). The caller also materializes it as a skill. */
export async function confirmLesson(projectKey: string, id: string): Promise<void> {
  try { await invoke("plan_lesson_confirm", { projectKey, id }); } catch { /* bridge absent */ }
}

/** Mark a candidate discarded (kept as a record; its seen count still grows if it recurs). */
export async function discardLesson(projectKey: string, id: string): Promise<void> {
  try { await invoke("plan_lesson_discard", { projectKey, id }); } catch { /* bridge absent */ }
}

/** Permanently delete a candidate. */
export async function removeLesson(projectKey: string, id: string): Promise<void> {
  try { await invoke("plan_lesson_remove", { projectKey, id }); } catch { /* bridge absent */ }
}

/** A confirmed lesson's display title — the corrective rule (the actionable part), else the mistake,
 *  capped so it slugs to a sane skill directory name. */
export function lessonTitle(lesson: Pick<Lesson, "mistake" | "rule">): string {
  const base = (lesson.rule.trim() || lesson.mistake.trim()).replace(/\s+/g, " ");
  return base.length > 64 ? `${base.slice(0, 61)}…` : base;
}

/**
 * Map a confirmed {@link Lesson} to a **project-scoped** {@link SkillDef} (the resolver then attaches
 * it to that project's future sessions). The skill is a `review`-kind corrective check: its body is
 * the transferable mistake → rule, scoped to `projectKey` (the user can later globalize it via the
 * normal skill-scope UI — that's the "promote to global" path, #1338). A stable id derived from the
 * lesson id keeps a re-confirm idempotent. Returns `null` when the lesson has nothing to name.
 */
export function lessonToSkill(lesson: Lesson, projectKey: string): (Omit<SkillDef, "id"> & { id: string }) | null {
  const name = lessonTitle(lesson);
  if (!skillSlug(name)) return null;
  const body = [
    lesson.mistake.trim() && `When: ${lesson.mistake.trim()}`,
    lesson.cause.trim() && `Why: ${lesson.cause.trim()}`,
    lesson.rule.trim() && `Do: ${lesson.rule.trim()}`,
  ].filter(Boolean).join("\n");
  return {
    ...blankSkill(),
    id: `lesson-skill-${lesson.id}`,
    name,
    kind: "review",
    source: "first-party",
    desc: lesson.mistake.trim() || lesson.rule.trim(),
    prompt: body,
    projects: projectKey ? [projectKey] : [],
    enabled: true,
  };
}
