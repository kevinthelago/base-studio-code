import { fnv1a32hex } from "./hash";

/**
 * Stable project identifier from a sanitized project name.
 * Format: "proj-{8 hex chars}" — deterministic, collision-resistant for typical
 * project-name spaces, and stable across renames only if the name doesn't change.
 * Stored in plan.json on first access so the id survives future title edits.
 */
export function projectId(sanitizedTitle: string): string {
  return `proj-${fnv1a32hex(sanitizedTitle)}`;
}

/**
 * Stable phase identifier from a phase name.
 * Format: "pid-{8 hex chars}". Used by the merge engine to key phase records.
 */
export function phaseId(phaseName: string): string {
  return `pid-${fnv1a32hex(phaseName)}`;
}

/**
 * Stable issue identifier — the canonical `id` field for the merge engine.
 * Maps directly from the desktop's `PlanIssue.ref` with no transformation:
 * the ref IS the stable id (the planner assigns it; it doesn't change).
 *
 * Parity point: the issue id field is "id" in the canonical model; desktop
 * calls it "ref". The bridge renames at the serialization boundary.
 */
export function issueId(ref: string): string {
  return ref;
}

/**
 * Stable PlanNode identifier for the adaptive planning tree (#201).
 * Format: "{kind}-{8 hex chars of title}". Deterministic across sessions so
 * the merge engine can key tree nodes stably.
 */
export function nodeId(kind: string, title: string): string {
  return `${kind}-${fnv1a32hex(title)}`;
}
