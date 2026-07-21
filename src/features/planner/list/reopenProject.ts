// Reopen a published project by DERIVATION, not lookup (#2409). A project's key is the slug of its
// name — so opening a board project resolves its local hub as `projectSlug(title)` directly, with no
// node-id → key alias table (the bridge that got the raw title in the "video game" bug and made
// recovery read the wrong hub). When no hub sits at that key, the ONE job the alias used to do is an
// explicit one-time choice instead: link an existing local project (a real on-disk move onto the
// name key, `relink_project_hub`) or start fresh. Pure — the modal + invoke live in
// ReopenProjectModal.tsx.

import { projectSlug, sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import type { LocalProjectLite } from "./drafts";

/** The derivation result for reopening a board project named `title` (#2409). */
export interface ReopenResolution {
  /** The canonical name-derived key — `projectSlug(title)`. */
  key: string;
  /** The local hub already at that key, when it exists (open directly — the normal case). */
  hub: LocalProjectLite | null;
  /**
   * When `hub` is null: every local hub as a link candidate, best-first — the legacy
   * title-sanitized key (`sanitizeProjectKey(title)`, the pre-#1741 folder key) first, then
   * case-insensitive title matches, then the rest by recency.
   */
  candidates: LocalProjectLite[];
  /**
   * The candidate to preselect in the link modal: an exact legacy-key or title match, else null
   * (never auto-suggest an unrelated hub).
   */
  suggested: LocalProjectLite | null;
}

/**
 * Resolve where a board project named `title` lives locally. Recovery is derivation: the key IS
 * `projectSlug(title)`; a hub at that key means open-in-place. Anything else is the reopen-mismatch
 * case the modal resolves (#2409).
 */
export function resolveReopen(title: string, locals: LocalProjectLite[]): ReopenResolution {
  const key = projectSlug(title);
  const safe = Array.isArray(locals) ? locals : [];
  const hub = safe.find((lp) => lp.key === key) ?? null;
  if (hub) return { key, hub, candidates: [], suggested: null };

  const legacyKey = sanitizeProjectKey(title);
  const titleNorm = title.trim().toLowerCase();
  const score = (lp: LocalProjectLite): number =>
    lp.key === legacyKey ? 0 : lp.title.trim().toLowerCase() === titleNorm ? 1 : 2;
  const candidates = [...safe].sort((a, b) => score(a) - score(b) || b.updatedAt - a.updatedAt);
  const suggested = candidates.length > 0 && score(candidates[0]) < 2 ? candidates[0] : null;
  return { key, hub: null, candidates, suggested };
}
