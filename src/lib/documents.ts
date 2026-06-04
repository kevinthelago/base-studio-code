// Unified document store (mirrors the Rust `DocInfo` from `list_documents`).
// One flat list spanning reusable KB articles, per-project planner docs, and
// per-repo docs (e.g. a repo's CLAUDE.local.md) — distinguished by `kind`.

export type DocKind = "reusable" | "project" | "repo";

export interface Doc {
  /** Base-relative path (e.g. `documents/x.md`); pass back to read/write_document. */
  relpath: string;
  name: string;
  title: string;
  kind: DocKind;
  /** Sanitized project key when `kind` is "project" or "repo", else null. */
  project: string | null;
  /** Repo short name when `kind === "repo"`, else null. */
  repo: string | null;
  tags: string[];
  size_bytes: number;
  modified_secs: number;
}

export type DocFilter = "all" | DocKind;

/** Filter chips, in display order. */
export const DOC_FILTERS: DocFilter[] = ["all", "reusable", "project", "repo"];

/** Human label for a kind/filter value. */
export function kindLabel(k: DocFilter): string {
  return k;
}

/**
 * Documents belonging to a specific project. A project can have more than one
 * folder key in the store (e.g. a title-keyed planner dir and a node-id-keyed
 * triage dir), so callers pass every candidate key and a doc matches if its
 * `project` is any of them. Both project- and repo-kind docs are scoped, since
 * repo docs live under a project.
 */
export function scopeToProject(docs: Doc[], keys: string[]): Doc[] {
  return docs.filter(
    d => (d.kind === "project" || d.kind === "repo") && d.project != null && keys.includes(d.project),
  );
}

/**
 * Filters documents by kind and a free-text query.
 *
 * The query is matched case-insensitively against the title, filename, project
 * key, repo, and tags. An empty query matches everything; filter `"all"`
 * disables the kind constraint. Returned order is preserved from the input
 * (already sorted most-recently-modified by the backend).
 */
export function filterDocuments(docs: Doc[], filter: DocFilter, query: string): Doc[] {
  const q = query.trim().toLowerCase();
  return docs.filter(d => {
    if (filter !== "all" && d.kind !== filter) return false;
    if (!q) return true;
    const hay = [d.title, d.name, d.project ?? "", d.repo ?? "", ...d.tags].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

// ─── Tag / stack faceting (#320) ──────────────────────────────────────────────

/**
 * The distinct tags across a document set, sorted alphabetically — the options
 * for the tag/stack filter facet. KB blocks are tagged with stack identifiers
 * (e.g. `rust`, `react`, `postgres`), so this same list serves both the "by tag"
 * and "by stack" filter: a stack is just a tag a block carries.
 */
export function collectTags(docs: Doc[]): string[] {
  const seen = new Set<string>();
  for (const d of docs) for (const t of d.tags) seen.add(t);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Keeps documents carrying ALL of the selected tags (AND semantics, so adding a
 * tag narrows the list). An empty selection imposes no constraint.
 */
export function filterByTags(docs: Doc[], tags: string[]): Doc[] {
  if (tags.length === 0) return docs;
  return docs.filter(d => tags.every(t => d.tags.includes(t)));
}

// ─── Full-text search incl. body (#321) ───────────────────────────────────────

/**
 * Case-insensitive substring match of a query against a document's title and —
 * when its body is supplied — its content. The metadata fields (filename,
 * project key, repo, tags) remain searchable too, so the search box keeps
 * finding docs by stack/project as before. An empty query matches everything.
 *
 * Body lookup is injected (the backend returns metadata only; the screen lazily
 * caches bodies) which keeps this predicate pure and unit-testable.
 */
export function matchesQuery(doc: Doc, query: string, body?: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [doc.title, doc.name, doc.project ?? "", doc.repo ?? "", ...doc.tags, body ?? ""]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** The selection state the KB list applies: source kind + tag facet + free text. */
export interface DocSelection {
  filter: DocFilter;
  tags: string[];
  query: string;
}

/**
 * The full list pipeline: source-kind filter → tag facet → free-text query
 * (title + body via the injected `bodies` map). Composing the three in one place
 * keeps the screen declarative and the behavior unit-testable. Input order is
 * preserved (the backend already sorts by recency).
 */
export function selectDocuments(
  docs: Doc[],
  selection: DocSelection,
  bodies?: Record<string, string>,
): Doc[] {
  const byKind = selection.filter === "all" ? docs : docs.filter(d => d.kind === selection.filter);
  const byTags = filterByTags(byKind, selection.tags);
  return byTags.filter(d => matchesQuery(d, selection.query, bodies?.[d.relpath]));
}

// ─── Grouping by kind (#320) ──────────────────────────────────────────────────

export interface DocGroup {
  kind: DocKind;
  label: string;
  docs: Doc[];
}

/** Kinds in display order for grouped rendering. */
const GROUP_ORDER: DocKind[] = ["reusable", "project", "repo"];

/**
 * Buckets documents under reusable / project / repo headers in display order.
 * Empty groups are dropped, so a list with only reusable docs renders a single
 * header. Within a group, input order (recency) is preserved.
 */
export function groupByKind(docs: Doc[]): DocGroup[] {
  return GROUP_ORDER.map(kind => ({
    kind,
    label: kindLabel(kind),
    docs: docs.filter(d => d.kind === kind),
  })).filter(g => g.docs.length > 0);
}
