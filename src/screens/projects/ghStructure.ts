// Pure helpers for the project planner's GitHub object graph.
//
// Kept free of React / xterm / Tauri imports so the derivation logic can be unit
// tested in isolation and shared between Planning.tsx and its tests.

// The planner is dynamic: Claude documents whatever topics a project warrants,
// so a section key is any file stem (`goal`, `security`, `data_lifecycle`, or a
// per-repo `repo__web__api`). `goal` and `phases` remain semantically special —
// the publish flow keys the project title and milestones off them.
export type SectionKey = string;
export type SectionState = "pending" | "drafted" | "confirmed";

export interface Section {
  k: SectionKey;
  title: string;
  state: SectionState;
  content: string;
}

export interface PhaseItem {
  name: string;
  description: string;
}

/** Parse the `phases` section content (a JSON array). Returns [] on any error. */
export function parsePhases(content: string): PhaseItem[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface GhNode { id: string; label: string; }

/** A repository plus the tracking issues that belong to it (one per phase). */
export interface GhRepoNode {
  node: GhNode;
  issues: GhNode[];
}

export interface GhStructure {
  project: GhNode;
  milestones: GhNode[];
  repos: GhRepoNode[];
}

/**
 * Derive the GitHub object graph from the confirmed/drafted plan. Pure — the
 * publish flow uses the same node ids so its status updates line up with the
 * structure card one-to-one.
 *
 * - one project board node
 * - one milestone node per phase
 * - one repo node per linked repository, each owning one tracking issue per phase
 *
 * Issue ids are namespaced by repo (`issue:{fullName}:{phaseIndex}`) so the same
 * phase produces a distinct, independently-tracked issue in every repo.
 */
export function buildGhStructure(sections: Section[], repos: string[], projectTitle: string): GhStructure {
  const phases = parsePhases(sections.find(s => s.k === "phases")?.content ?? "");
  return {
    project:    { id: "project", label: projectTitle },
    milestones: phases.map((ph, i) => ({ id: `ms:${i}`, label: ph.name })),
    repos: repos.map(fullName => ({
      node:   { id: `repo:${fullName}`, label: fullName },
      issues: phases.map((ph, i) => ({
        id:    `issue:${fullName}:${i}`,
        label: `[${ph.name}] ${projectTitle}`,
      })),
    })),
  };
}
