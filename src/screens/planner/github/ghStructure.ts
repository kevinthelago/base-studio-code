// Pure helpers for the project planner's GitHub object graph.
//
// Kept free of React / xterm / Tauri imports so the derivation logic can be unit
// tested in isolation and shared between Planning.tsx and its tests.

import { parseIssuesFile } from "../issues/planIssues";
import type { FleetPlan } from "../planSections";

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

/** A fleet stream as a GitHub object: the `stream:<id>` label and the issues it owns. */
export interface GhStreamNode {
  /** Status-map id, namespaced `stream:<id>` (also the label name). */
  id: string;
  label: string;
  repo: string;
  /** Owned issue refs (e.g. `#12`). */
  issues: string[];
}

export interface GhStructure {
  project: GhNode;
  milestones: GhNode[];
  repos: GhRepoNode[];
  streams: GhStreamNode[];
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
export function buildGhStructure(
  sections: Section[],
  repos: string[],
  projectTitle: string,
  fleet?: FleetPlan,
): GhStructure {
  const phases = parsePhases(sections.find(s => s.k === "phases")?.content ?? "");
  const planIssues = parseIssuesFile(sections.find(s => s.k === "issues")?.content ?? "");
  return {
    project:    { id: "project", label: projectTitle },
    milestones: phases.map((ph, i) => ({ id: `ms:${i}`, label: ph.name })),
    repos: repos.map((fullName, repoIdx) => ({
      node:   { id: `repo:${fullName}`, label: fullName },
      // Granular issues (#311) when the planner defined them: one node per
      // PlanIssue belonging to this repo (its `repo`, or the default repo when
      // unset). Otherwise fall back to the legacy one-tracker-per-phase nodes.
      issues: planIssues.length
        ? planIssues
            .filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0)
            .map((iss, idx) => ({ id: `issue:${fullName}:${iss.ref ?? idx}`, label: iss.title }))
        : phases.map((ph, i) => ({
            id:    `issue:${fullName}:${i}`,
            label: `[${ph.name}] ${projectTitle}`,
          })),
    })),
    streams: (fleet?.streams ?? []).map(st => ({
      id:     `stream:${st.id}`,
      label:  st.name,
      repo:   st.repo,
      issues: st.issues,
    })),
  };
}
