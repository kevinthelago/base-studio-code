// Document-assignment model — the single source of truth for *which* unified-store
// document seeds a session's kickoff message:
//
//   • startupPrompt — the ONE document that seeds a session's kickoff message.
//
// ─── Mental model: "global default + overrides" ───────────────────────────────
//
// `startupPrompt` is assigned along a four-level cascade, from broadest to most
// specific:
//
//   default  →  project  →  repo  →  session
//
// `default` is the global baseline that applies everywhere. Each narrower level
// refines it for a smaller scope (one project, one repo within a project, one
// live session/pane):
//
//   startupPrompt — OVERRIDE. Exactly one document wins. The most specific level
//                   that names a document supplies it; an absent / null entry
//                   means "inherit" and falls through to the next broader level.
//                   Nothing assigned anywhere → null (the caller uses its
//                   built-in default prompt).
//
// Resolution is PURE — no I/O, no store access. Callers (session launch in #326)
// hold the {@link DocAssignments} state and call {@link resolveStartupPrompt} at
// launch time.

/** A unified-store document, identified by its base-relative path (see documents.ts). */
export type DocRef = string;

/** The scope a session runs in. Any level may be absent (e.g. an ad-hoc console
 *  with no project). Resolution only consults the levels a scope provides. */
export interface AssignmentScope {
  /** Sanitized project key, or null/absent for an unscoped session. */
  projectId?: string | null;
  /** Full repo name (e.g. `owner/web`), or null/absent. */
  repo?: string | null;
  /** Live session / pane id, or null/absent. The narrowest level. */
  session?: string | null;
}

/** Composite key for a per-repo assignment, scoped to its project so the same
 *  repo under two projects never collides. */
export function scopeKey(projectId: string, repo: string): string {
  return `${projectId}::${repo}`;
}

// ─── Startup prompt: single-doc override cascade ──────────────────────────────

/** Per-level assignment of the kickoff document. A `null`/absent value at a
 *  level means "inherit" (fall through to the next broader level). */
export interface StartupPromptCascade {
  /** Global default kickoff document, or null for the built-in prompt. */
  default: DocRef | null;
  /** Overrides keyed by project id. */
  project: Record<string, DocRef | null>;
  /** Overrides keyed by {@link scopeKey}. */
  repo: Record<string, DocRef | null>;
  /** Overrides keyed by session/pane id. */
  session: Record<string, DocRef | null>;
}

/** The complete assignment state for a workspace. */
export interface DocAssignments {
  startupPrompt: StartupPromptCascade;
}

/** A fresh, fully-empty assignment state. */
export function emptyAssignments(): DocAssignments {
  return {
    startupPrompt: { default: null, project: {}, repo: {}, session: {} },
  };
}

/**
 * The cascade levels that apply to a scope, broadest → narrowest. Levels whose
 * scope key is absent are skipped (an unscoped console only ever sees `default`).
 */
function startupLevels(a: StartupPromptCascade, scope: AssignmentScope): (DocRef | null | undefined)[] {
  const out: (DocRef | null | undefined)[] = [a.default];
  if (scope.projectId) out.push(a.project[scope.projectId]);
  if (scope.projectId && scope.repo) out.push(a.repo[scopeKey(scope.projectId, scope.repo)]);
  if (scope.session) out.push(a.session[scope.session]);
  return out;
}

/**
 * Resolves the single kickoff document for a scope, following
 * session → repo → project → default. The most specific level that names a
 * document wins; a `null`/absent entry inherits from the next broader level.
 * Returns `null` when nothing is assigned at any applicable level, in which case
 * the caller uses its built-in default prompt.
 */
export function resolveStartupPrompt(
  assignments: DocAssignments,
  scope: AssignmentScope,
): DocRef | null {
  const levels = startupLevels(assignments.startupPrompt, scope);
  // Walk narrowest → broadest; first explicit (truthy) value wins.
  for (let i = levels.length - 1; i >= 0; i--) {
    const v = levels[i];
    if (v) return v;
  }
  return null;
}
