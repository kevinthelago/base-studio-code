/** One file in the canonical plan representation — the atomic sync unit. */
export interface CanonicalFile {
  /** Relative path within the project hub (e.g. "goal.md", "phases.json"). */
  relpath: string;
  /** Raw text content (UTF-8). */
  content: string;
}

/**
 * Compact reconciliation payload: relpath → lowercase 8-char hex FNV-1a 32-bit hash.
 * Both peers exchange this to discover which files differ without transferring content.
 */
export interface PlanManifest {
  /** Stable project identifier (e.g. "proj-bf9cf968"). */
  projectId: string;
  /** Map from relpath to content hash. */
  files: Record<string, string>;
}

/**
 * Canonical section-state vocabulary (the unified cross-device spec).
 *
 * Desktop vocab map:
 *   pending   → surfaced   (Claude has written the section; user hasn't confirmed)
 *   drafted   → drafted    (Claude has drafted it; in-progress)
 *   confirmed → confirmed  (User explicitly confirmed)
 *
 * _skipped.md entries are individually mapped to "skipped".
 *
 * See plannerCore.fixtures.json (sectionStates section) for the pinned mapping.
 */
export type CanonicalSectionState = "surfaced" | "drafted" | "confirmed" | "skipped";

/** Metadata stored in plan.json — stable identity and per-section states. */
export interface PlanMeta {
  /** Stable "proj-{hex}" identifier (hash-derived from the sanitized title). */
  projectId: string;
  /** Human-readable project title (the sanitized form). */
  title: string;
  /** Per-section canonical states, keyed by section key (e.g. "goal", "scope"). */
  sectionStates: Record<string, CanonicalSectionState>;
}
