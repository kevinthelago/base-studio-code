// Hub dir ↔ canonical file map + plan.json bridge.
//
// Pure — no filesystem I/O, no Tauri, no React. Takes the in-memory plan state
// (as held by the Zustand store) and produces the canonical CanonicalFile list
// the sync layer transmits. Also applies a received push back to a HubSnapshot
// so the calling code can update the store.

import type { CanonicalFile, PlanMeta, CanonicalSectionState } from "../plannerCore/types";
import { projectId as mintProjectId } from "../plannerCore/ids";
import { parseSkipped } from "../../screens/planner/planSections";

/** In-memory representation of the plan hub's current state (from the Zustand store). */
export interface HubSnapshot {
  /** Sanitized project title — used to derive projectId on first access. */
  projectTitle: string;
  /** Stable "proj-{hex}" id if already minted; derived from title otherwise. */
  existingProjectId?: string;
  /** Section content keyed by section key (e.g. "goal", "scope"). Only drafted/confirmed. */
  sections: Record<string, string>;
  /** Section keys whose state is "confirmed" (user clicked confirm in the UI). */
  confirmedSections: string[];
  /** Raw issues.json content (undefined if not yet authored). */
  issuesJson?: string;
  /** Raw phases.json content (undefined if not yet authored). */
  phasesJson?: string;
  /** Raw fleet.json content (undefined if not yet authored). */
  fleetJson?: string;
  /** Raw repos.json content (undefined if not yet authored). */
  reposJson?: string;
  /** Raw _skipped.md content (undefined if no sections have been skipped). */
  skippedContent?: string;
}

/** Result of converting a HubSnapshot to the canonical representation. */
export interface CanonicalBuild {
  /** Sorted list of plan files ready for hashing and transmission. */
  files: CanonicalFile[];
  /** The plan metadata (written to / read from plan.json). */
  meta: PlanMeta;
}

/**
 * Convert an in-memory hub snapshot to the canonical file list + plan metadata.
 *
 * Each section becomes a `{key}.md` file. JSON plan files (phases, issues, fleet,
 * repos) are included as-is. Skipped sections are recorded in the sectionStates
 * map as "skipped". plan.json is always included and carries the stable projectId.
 *
 * Sections missing from confirmedSections are treated as "drafted" (they have
 * content but the user hasn't explicitly confirmed them). There is no "surfaced"
 * state in the current desktop model — sections aren't tracked until Claude
 * writes them.
 */
export function hubToCanonical(snap: HubSnapshot): CanonicalBuild {
  const pid = snap.existingProjectId ?? mintProjectId(snap.projectTitle);
  const sectionStates: Record<string, CanonicalSectionState> = {};
  const files: CanonicalFile[] = [];

  for (const [key, content] of Object.entries(snap.sections)) {
    if (!content?.trim()) continue;
    files.push({ relpath: `${key}.md`, content });
    sectionStates[key] = snap.confirmedSections.includes(key) ? "confirmed" : "drafted";
  }

  if (snap.skippedContent?.trim()) {
    files.push({ relpath: "_skipped.md", content: snap.skippedContent });
    for (const { topic } of parseSkipped(snap.skippedContent)) {
      if (topic) sectionStates[topic] = "skipped";
    }
  }

  const jsonEntries: Array<[string, string | undefined]> = [
    ["phases.json",  snap.phasesJson],
    ["issues.json",  snap.issuesJson],
    ["fleet.json",   snap.fleetJson],
    ["repos.json",   snap.reposJson],
  ];
  for (const [relpath, content] of jsonEntries) {
    if (content?.trim()) files.push({ relpath, content });
  }

  const meta: PlanMeta = { projectId: pid, title: snap.projectTitle, sectionStates };
  files.push({ relpath: "plan.json", content: JSON.stringify(meta, null, 2) });
  files.sort((a, b) => a.relpath.localeCompare(b.relpath));

  return { files, meta };
}

/**
 * Apply a push (incoming CanonicalFile list from mobile) onto a HubSnapshot.
 * Full-replace semantics: pushed files overwrite the corresponding local state.
 * Returns a new snapshot — the original is not mutated.
 */
export function applyPush(snap: HubSnapshot, pushed: CanonicalFile[]): HubSnapshot {
  const sections = { ...snap.sections };
  let { existingProjectId, phasesJson, issuesJson, fleetJson, reposJson, skippedContent } = snap;

  for (const { relpath, content } of pushed) {
    if (relpath === "plan.json") {
      try {
        const m = JSON.parse(content) as Partial<PlanMeta>;
        if (typeof m.projectId === "string" && m.projectId) existingProjectId = m.projectId;
      } catch { /* ignore malformed plan.json */ }
    } else if (relpath === "_skipped.md") {
      skippedContent = content;
    } else if (relpath === "phases.json")  { phasesJson  = content; }
    else if (relpath === "issues.json")    { issuesJson  = content; }
    else if (relpath === "fleet.json")     { fleetJson   = content; }
    else if (relpath === "repos.json")     { reposJson   = content; }
    else if (relpath.endsWith(".md") && !relpath.includes("/")) {
      sections[relpath.slice(0, -3)] = content;
    }
  }

  return { ...snap, existingProjectId, sections, phasesJson, issuesJson, fleetJson, reposJson, skippedContent };
}

/** True if a hub-relative path belongs to the synced plan (included in the canonical map). */
export function isPlanFile(relpath: string): boolean {
  if (relpath.includes("/")) return false;  // no subdirectory files
  if (relpath.endsWith(".md")) return true;
  return ["phases.json", "issues.json", "fleet.json", "repos.json", "plan.json"].includes(relpath);
}
