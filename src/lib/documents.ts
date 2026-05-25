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
