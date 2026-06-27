# Archived: Plan grading system

The advisory, non-gating in-app plan-grading layer — pluggable per-section graders, `sectionGrades`, the `scoreColor`/`GradeChip` UI, and the cleanup-grade dead-code scan. No gate, publish, or progression ever consulted a grade; removed end to end in #1459 (with #1468 / #1473).

Deleted from GitHub; full content below. Machine-readable mirror: `plan-grading.jsonl`.

**Issues (4):** #615, #620, #686, #688

---

## #615 — feat(grading): pluggable per-section graders as pipelines (multiple per section)

- **state:** CLOSED (COMPLETED) · **labels:** feature, scope:core
- **created:** 2026-06-09T04:07:51Z · **closed:** 2026-06-09T20:50:13Z

Generalize plan grading into pluggable **graders** that run as pipelines and render in the pipeline screen, with **multiple graders per section**. Slice (a): the Grader/GradeResult contract + a deterministic, data-driven **rubric grader** (signal gates via evalGate + content heuristics) + a default per-section-kind rubric registry (distributable like blueprints). Slices: (b) report-card pipeline screen + generalize stagePlanGrade to project→section→grader; (c) wrap the existing agent-readiness grader onto the contract; (d) LLM rubric grader for prose sections.

---

## #620 — refactor(grading): fold stagePlanGrade into sectionGrades (single source)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core
- **created:** 2026-06-09T06:31:59Z · **closed:** 2026-06-09T20:50:13Z

Remove the agent-readiness dual-write. Make sectionGrades the single source: the grade-plan dispatch writes only the section grade, carrying the rich PlanGrade as the GradeResult's opaque `detail`. ProjectPane reads the structure section's agent-readiness result (uses .detail for the rich report + per-issue chips). Drop stagePlanGrade/setStagePlanGrade from the store.

---

## #686 — Grading: unify grade colors — two scoreColor impls + GradeChip map disagree

- **state:** CLOSED (COMPLETED) · **labels:** bug
- **created:** 2026-06-11T12:02:51Z · **closed:** 2026-06-12T22:41:29Z

From the grading audit: the same grade renders different colors depending on the surface.
- `letterFromScore` (src/lib/planGrade.ts) is the one true threshold set (A≥.90 B≥.75 C≥.60 D≥.45 F).
- But color is derived three inconsistent ways: `GradeChip` letter→color map (ProjectPane), `scoreColor` on a 0–1 scale (ProjectPane: .75/.60/.45), and `scoreColor` on a 0–100 scale (GradeReportPane: 80/60/40). A 50% category shows orange in one pane, red in another; bar colors can disagree with the letter chip.

Fix: one source of truth in planGrade.ts — `letterColor(letter)` + `gradeColor(score0to1) = letterColor(letterFromScore(score))` — and route GradeChip + both scoreColor call sites through it. Bounded slice of the broader grading consolidation (#).

### Comments

**kevinthelago** (2026-06-12T22:41:28Z):

Completed by #687 (merged to develop). The auto-close link didn't fire because develop's history was rebased after merge, severing the `Closes #` reference.

---

## #688 — Cleanup grade: unreviewed (uncertain) dead-code candidates read as a clean A

- **state:** CLOSED (COMPLETED) · **labels:** bug
- **created:** 2026-06-11T12:12:01Z · **closed:** 2026-06-16T08:25:14Z

findingsToGrade (src/lib/deadcodeVerify.ts) only penalizes CONFIRMED dead code — uncertain candidates (e.g. when no API key verified them) contribute 0, so a section full of unverified candidates scores a perfect 100/A. Misleading. Uncertain candidates should ding the score lightly (they're review debt) and be surfaced in the dimension note. Empty (scan ran, nothing found) stays 100/A.

---
