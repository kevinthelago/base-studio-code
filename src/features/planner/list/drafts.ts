// Pure draft-list selection for the Projects page (#1449). Extracted from ProjectsList so the
// "published hub leaks into Drafts" dedup is unit-testable.
//
// The Drafts list = on-disk local hubs ∪ the store draft map, MINUS anything already published.
// Published-ness is the authoritative in-place `.published` marker (#922), surfaced per hub as
// `LocalProject.published`. The earlier dedup excluded a draft only when its folder `key` matched
// a title-derived key or a node-id alias value — a fragile derivation that drifts from the marker:
// `sanitizeProjectKey` is case-PRESERVING, but the published-marker reconcile matches the GitHub
// board case-INSENSITIVELY (and the title is read from goal.md), so a hub whose folder key differs
// in case/spelling from the board title got marked published yet survived the draft filter —
// showing in BOTH lists. Keying off `lp.published` is the fix; the board-title keys stay as a
// secondary signal for hubs the reconcile hasn't marked yet. (The node-id alias is retired, #2409 —
// a board's key derives from its name.)

/** The fields of the backend `LocalProject` this selection needs. */
export interface LocalProjectLite {
  key: string;
  title: string;
  hasPlan: boolean;
  updatedAt: number;
  published: boolean;
  /** True when the title came from the `.title` sidecar (user input) — false = derived (de-slugged
   *  key / goal.md / placeholder), the board-title backfill's target set (#2467). Optional only for
   *  older fixtures; the live wire always carries it. */
  titled?: boolean;
}

/** A store draft-map entry (`addDraftProject`). */
export interface DraftMapEntry { title: string; pitch: string; createdAt: number }

/** A row in the Drafts list. */
export interface DraftRow { key: string; title: string; pitch: string; sort: number }

/**
 * Build the Drafts list, dropping every already-published project.
 *
 * @param localProjects     on-disk hubs from `list_local_projects` (carry the `.published` marker).
 * @param localDraftProjects the store's draft map (key → {title, pitch, createdAt}).
 * @param publishedTitleKeys every key form of each visible GitHub board title — the name-derived
 *                           `projectSlug(title)` (#2409) plus the legacy `sanitizeProjectKey(title)`
 *                           for grandfathered title-keyed hubs.
 * @returns draft rows, deduped by key, sorted not applied (caller sorts).
 */
export function buildDrafts(
  localProjects: LocalProjectLite[],
  localDraftProjects: Record<string, DraftMapEntry>,
  publishedTitleKeys: string[],
): DraftRow[] {
  const safeLocals = Array.isArray(localProjects) ? localProjects : [];
  const publishedKeys = new Set<string>([
    ...publishedTitleKeys,
    // The authoritative signal (#922): a hub flagged published is never a draft, regardless of
    // whether its folder key matches a board-title-derived key.
    ...safeLocals.filter(lp => lp?.published).map(lp => lp.key),
  ]);

  const byKey = new Map<string, DraftRow>();
  for (const lp of safeLocals) {
    // A hub is a draft when it has a plan OR the user named it (`titled`, #2994) — a user-titled hub
    // with a plan.db but no goal/scope section yet is still a real draft. Only a bare, UNTITLED
    // scaffold is skipped. (Interim until the DB-backed list, epic #2993.)
    if (!lp?.hasPlan && !lp?.titled) continue;
    if (lp.published) continue;   // published hubs are not drafts (#922)
    byKey.set(lp.key, { key: lp.key, title: lp.title, pitch: "", sort: lp.updatedAt });
  }
  for (const [key, d] of Object.entries(localDraftProjects)) {
    const ex = byKey.get(key);
    byKey.set(key, { key, title: d.title, pitch: d.pitch, sort: Math.max(ex?.sort ?? 0, d.createdAt) });
  }
  return [...byKey.values()].filter(d => !publishedKeys.has(d.key));
}
