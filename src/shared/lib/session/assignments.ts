// Document-assignment model — the single source of truth for *which* unified-store
// documents apply to a session, split into two distinct fields:
//
//   • startupPrompt   — the ONE document that seeds a session's kickoff message.
//   • referenceContext — the SET of documents injected as background context
//                        (knowledge blocks, plan files, conventions).
//
// ─── Mental model: "global default + overrides" ───────────────────────────────
//
// Both fields are assigned along the SAME four-level cascade, from broadest to
// most specific:
//
//   default  →  project  →  repo  →  session
//
// `default` is the global baseline that applies everywhere. Each narrower level
// refines it for a smaller scope (one project, one repo within a project, one
// live session/pane). The two fields differ ONLY in how the levels combine:
//
//   startupPrompt  — OVERRIDE. Exactly one document wins. The most specific
//                    level that names a document supplies it; an absent / null
//                    entry means "inherit" and falls through to the next
//                    broader level. Nothing assigned anywhere → null (the caller
//                    uses its built-in default prompt). This supersedes the
//                    interim `resolveStartupPromptDoc` in startupPrompt.ts — it
//                    is the same cascade with an added per-session level.
//
//   referenceContext — ACCUMULATE. Context is additive: the resolved set is the
//                    union of every level's contribution, broadest first, so a
//                    session sees the global blocks PLUS its project's PLUS its
//                    repo's PLUS its own. Overrides are still explicit: a level
//                    may `remove` an inherited document, or `replace` to discard
//                    everything inherited from broader levels before adding.
//
// Resolution is PURE — no I/O, no store access. Callers (the KB assignment UI in
// #325, session launch in #326) hold the {@link DocAssignments} state and call
// {@link resolveStartupPrompt} / {@link resolveReferenceContext} at launch time.

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

// ─── Reference context: accumulating set with explicit overrides ──────────────

/** One cascade level's contribution to the injected reference-context set. */
export interface RefContextLevel {
  /** Documents this level adds to the injected set. */
  add: DocRef[];
  /** Inherited documents this level removes (override-by-exclusion). */
  remove?: DocRef[];
  /** When true, discard everything inherited from broader levels before adding —
   *  a hard override rather than a refinement. */
  replace?: boolean;
}

export interface ReferenceContextCascade {
  default: RefContextLevel;
  project: Record<string, RefContextLevel>;
  repo: Record<string, RefContextLevel>;
  session: Record<string, RefContextLevel>;
}

/** The complete assignment state for a workspace: both fields, both cascades. */
export interface DocAssignments {
  startupPrompt: StartupPromptCascade;
  referenceContext: ReferenceContextCascade;
}

/** An empty contribution — the identity for {@link resolveReferenceContext}. */
export function emptyRefContextLevel(): RefContextLevel {
  return { add: [] };
}

/** A fresh, fully-empty assignment state. */
export function emptyAssignments(): DocAssignments {
  return {
    startupPrompt: { default: null, project: {}, repo: {}, session: {} },
    referenceContext: {
      default: emptyRefContextLevel(),
      project: {},
      repo: {},
      session: {},
    },
  };
}

/**
 * The cascade levels that apply to a scope, broadest → narrowest. Levels whose
 * scope key is absent are skipped (an unscoped console only ever sees `default`).
 * Exposed so both resolvers walk the levels identically.
 */
function startupLevels(a: StartupPromptCascade, scope: AssignmentScope): (DocRef | null | undefined)[] {
  const out: (DocRef | null | undefined)[] = [a.default];
  if (scope.projectId) out.push(a.project[scope.projectId]);
  if (scope.projectId && scope.repo) out.push(a.repo[scopeKey(scope.projectId, scope.repo)]);
  if (scope.session) out.push(a.session[scope.session]);
  return out;
}

function refContextLevels(a: ReferenceContextCascade, scope: AssignmentScope): RefContextLevel[] {
  const out: RefContextLevel[] = [a.default];
  if (scope.projectId && a.project[scope.projectId]) out.push(a.project[scope.projectId]);
  if (scope.projectId && scope.repo) {
    const lvl = a.repo[scopeKey(scope.projectId, scope.repo)];
    if (lvl) out.push(lvl);
  }
  if (scope.session && a.session[scope.session]) out.push(a.session[scope.session]);
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

/**
 * Resolves the injected reference-context set for a scope by accumulating every
 * applicable level broadest → narrowest. Each level may `replace` (clear the
 * inherited set first), `add` documents, and `remove` inherited ones. The result
 * is deduplicated by relpath, preserving first-seen (broadest) order — so the
 * global baseline blocks lead and the session's own additions trail.
 */
export function resolveReferenceContext(
  assignments: DocAssignments,
  scope: AssignmentScope,
): DocRef[] {
  const levels = refContextLevels(assignments.referenceContext, scope);
  let acc: DocRef[] = [];
  for (const lvl of levels) {
    if (lvl.replace) acc = [];
    for (const doc of lvl.add) {
      if (!acc.includes(doc)) acc.push(doc);
    }
    if (lvl.remove && lvl.remove.length > 0) {
      const drop = new Set(lvl.remove);
      acc = acc.filter((d) => !drop.has(d));
    }
  }
  return acc;
}

/**
 * Resolves both fields for a scope in one call — the shape session launch (#326)
 * consumes. `startupPrompt` is null when the built-in default should be used;
 * `referenceContext` is possibly empty.
 */
export function resolveAssignments(
  assignments: DocAssignments,
  scope: AssignmentScope,
): { startupPrompt: DocRef | null; referenceContext: DocRef[] } {
  return {
    startupPrompt: resolveStartupPrompt(assignments, scope),
    referenceContext: resolveReferenceContext(assignments, scope),
  };
}

/** Heading the injected reference-context blocks are placed under in a launch prompt. */
export const REFERENCE_CONTEXT_HEADING = "# Reference context (assigned knowledge)";

/**
 * True when a reference-context relpath is one of the planner's discovery/context
 * plan-section files (`projects/<key>/context/goal.md`, `…/discovery/scope.md`, …)
 * — identified by a `context/` or `discovery/` path segment.
 *
 * These are the planner's internal working files, NOT "assigned knowledge". A
 * triage session resumes a repo's issue backlog and must not be seeded with the
 * raw project goal/scope/etc. (#1807): the now-removed KB reference-context
 * assignment UI (#1460) auto-assigned them at the project level, and that
 * assignment persists in `refContextProject`, so they leak in as a bare `# Goal`
 * heading. Triage filters them out of its resolved reference set with this guard.
 */
export function isDiscoveryContextDoc(relpath: string): boolean {
  return /(^|\/)(context|discovery)\//.test(relpath);
}

/**
 * Folds resolved reference-context document contents onto a session's startup
 * prompt for delivery (#326). Empty/blank blocks are dropped; when nothing is
 * left the `base` is returned unchanged. When there is no base prompt but there
 * is context, the context section becomes the prompt so it is still delivered.
 */
export function composeReferenceContext(
  base: string | undefined,
  contents: string[],
): string | undefined {
  const blocks = contents.map((c) => c.trim()).filter(Boolean);
  if (blocks.length === 0) return base;
  const section = `${REFERENCE_CONTEXT_HEADING}\n\n${blocks.join("\n\n---\n\n")}`;
  return base ? `${base}\n\n${section}` : section;
}
