// Capability-aware GitHub mapping (#203) — separate the *logical* plan structure
// from the *physical* GitHub primitives, and bind the mapping LATE, per the
// connected account's capabilities. The planner works in logical concepts (epic,
// hierarchy, dependency…); this module picks the physical representation, degrading
// gracefully when a richer primitive isn't available (e.g. a personal account has
// sub-issues but not custom issue *types*).
//
// Late binding = "prepare for both": the same logical plan re-publishes against a
// richer profile (move to an org) with no plan change. Pure model core — detection
// and the publish adapter build on it. Free of React / xterm / Tauri imports.

/** What a connected account/repo can do. Detected on connect, cached, refreshable. */
export interface CapabilityProfile {
  accountType: "user" | "org";
  /** Native parent/child issues with rollup. */
  subIssues: boolean;
  /** Custom issue types (Epic/Feature/…) — organization-only. */
  issueTypes: boolean;
  /** Native "blocked-by" issue relationships. */
  nativeDependencies: boolean;
  /** Projects v2 (custom fields, iterations). */
  projects: boolean;
}

/** A personal account (the common case): sub-issues yes, issue types no. */
export function personalProfile(over: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    accountType: "user",
    subIssues: true,
    issueTypes: false,
    nativeDependencies: false,
    projects: true,
    ...over,
  };
}

/** A fully-capable organization. */
export function orgProfile(over: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    accountType: "org",
    subIssues: true,
    issueTypes: true,
    nativeDependencies: true,
    projects: true,
    ...over,
  };
}

/** Build a profile from raw detected flags, defaulting conservatively. */
export function detectProfile(raw: Partial<CapabilityProfile> & { accountType: "user" | "org" }): CapabilityProfile {
  return {
    accountType: raw.accountType,
    subIssues: raw.subIssues ?? true,
    // Issue types are org-only — never claim them for a user account.
    issueTypes: raw.accountType === "org" ? raw.issueTypes ?? false : false,
    nativeDependencies: raw.nativeDependencies ?? false,
    projects: raw.projects ?? true,
  };
}

// ── The logical → physical degradation ladder ──────────────────────────────────

export type LogicalConcept =
  | "epic"
  | "issue-type"
  | "hierarchy"
  | "dependency"
  | "phase"
  | "stream";

/** One rung of a degradation ladder — a physical representation + what it needs. */
export interface Rung {
  /** Short id for the physical representation. */
  id: string;
  /** Human description of how the concept is realized. */
  representation: string;
  /** Whether this rung is supported by a profile. */
  supports: (p: CapabilityProfile) => boolean;
}

/** Always-supported fallback predicate. */
const always = () => true;

/** Each concept's ladder, richest rung first; the last rung is always supported. */
const LADDERS: Record<LogicalConcept, Rung[]> = {
  epic: [
    { id: "issue-type+sub-issues", representation: "Epic issue type + sub-issues", supports: (p) => p.issueTypes && p.subIssues },
    { id: "parent+sub-issues+label", representation: "parent issue + sub-issues + epic label", supports: (p) => p.subIssues },
    { id: "parent+task-list", representation: "parent issue + task-list", supports: always },
  ],
  "issue-type": [
    { id: "native-type", representation: "custom issue type", supports: (p) => p.issueTypes },
    { id: "label", representation: "type:* label", supports: always },
  ],
  hierarchy: [
    { id: "sub-issues", representation: "sub-issues (rollup)", supports: (p) => p.subIssues },
    { id: "task-lists", representation: "task-lists", supports: always },
  ],
  dependency: [
    { id: "native-relationship", representation: "native blocked-by relationship", supports: (p) => p.nativeDependencies },
    { id: "project-field", representation: "Project depends_on field", supports: (p) => p.projects },
    { id: "body-text", representation: "body depends_on: text", supports: always },
  ],
  phase: [
    { id: "iteration", representation: "Project iteration", supports: (p) => p.projects },
    { id: "milestone", representation: "milestone", supports: always },
  ],
  stream: [
    { id: "label+epic", representation: "stream label + epic parent", supports: (p) => p.subIssues },
    { id: "label", representation: "stream label", supports: always },
  ],
};

/**
 * Pick the physical representation for a logical concept on a given profile — the
 * **highest supported rung** of its degradation ladder. Always returns a rung (the
 * last is the universal fallback).
 */
export function mapConcept(concept: LogicalConcept, profile: CapabilityProfile): Rung {
  const ladder = LADDERS[concept];
  return ladder.find((rung) => rung.supports(profile)) ?? ladder[ladder.length - 1];
}

/** The full logical→physical mapping for a profile — concept → chosen rung id. */
export function summarizeMapping(profile: CapabilityProfile): Record<LogicalConcept, string> {
  const out = {} as Record<LogicalConcept, string>;
  for (const concept of Object.keys(LADDERS) as LogicalConcept[]) {
    out[concept] = mapConcept(concept, profile).id;
  }
  return out;
}

/** The ladder for a concept (richest first) — for UI / provenance display. */
export function ladderFor(concept: LogicalConcept): readonly Rung[] {
  return LADDERS[concept];
}
