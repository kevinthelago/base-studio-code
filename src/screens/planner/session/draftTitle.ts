// Commit a DRAFT project's title edit (#1222) — the pure guard, extracted from Planning.tsx so
// it's unit-testable. The draft record (localDraftProjects[key].title, persisted) is the source of
// truth a reopen reads, so persisting the edit there is what makes it survive. The FROZEN key is
// kept — the new title is a display name; the on-disk folder doesn't move (stable-id refactor).

import { sanitizeProjectKey } from "../../../lib/core/projectPaths";

export type DraftCommit =
  | { kind: "revert" }                       // empty → restore the saved title
  | { kind: "noop" }                         // unchanged
  | { kind: "error"; message: string }       // collides with another project
  | { kind: "commit"; title: string };       // persist the new title

/**
 * Decide what blurring/Entering the draft title input should do, given the raw input, the saved
 * draft title, and the OTHER projects' keys (drafts + published aliases) for the duplicate guard.
 * Empty reverts; unchanged no-ops; a name that slugifies onto another project's key errors;
 * otherwise commit the trimmed title.
 */
export function planDraftCommit(raw: string, saved: string, otherKeys: ReadonlySet<string>): DraftCommit {
  const next = raw.trim();
  if (!next) return { kind: "revert" };
  if (next === saved) return { kind: "noop" };
  if (otherKeys.has(sanitizeProjectKey(next))) {
    return { kind: "error", message: "Another project already uses that name." };
  }
  return { kind: "commit", title: next };
}
