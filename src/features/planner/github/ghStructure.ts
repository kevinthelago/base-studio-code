// Pure helpers for the project planner's GitHub object graph.
//
// Kept free of React / xterm / Tauri imports so the derivation logic can be unit
// tested in isolation and shared between Planning.tsx and its tests.

import { parseFeaturesFile, featuresToPlanIssues } from "../issues/featureList";
import type { FleetPlan } from "../fleet/planFleet";

// The planner is dynamic: Claude documents whatever topics a project warrants,
// so a section key is any file stem (`goal`, `security`, `data_lifecycle`, or a
// per-repo `repo__web__api`). `goal` remains semantically special — the publish
// flow keys the project title off it.
export type SectionKey = string;
export type SectionState = "pending" | "drafted" | "confirmed";

export interface Section {
  k: SectionKey;
  title: string;
  state: SectionState;
  content: string;
}

export interface GhNode { id: string; label: string; }

/** A repository plus the issues that belong to it (one per feature). */
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
  repos: GhRepoNode[];
  streams: GhStreamNode[];
}

/**
 * Derive the GitHub object graph from the confirmed/drafted plan. Pure — the
 * publish flow uses the same node ids so its status updates line up with the
 * structure card one-to-one.
 *
 * - one project board node
 * - one repo node per linked repository, each owning one issue per feature
 *
 * Issue ids are namespaced by repo (`issue:{fullName}:{ref}`).
 */
export function buildGhStructure(
  sections: Section[],
  repos: string[],
  projectTitle: string,
  fleet?: FleetPlan,
): GhStructure {
  // Issues are generated from the features (one per feature) — issues aren't authored during
  // planning (#plan-db). The card shows the same nodes publish will create.
  const planIssues = featuresToPlanIssues(parseFeaturesFile(sections.find(s => s.k === "features")?.content ?? ""));
  return {
    project:    { id: "project", label: projectTitle },
    repos: repos.map((fullName, repoIdx) => ({
      node:   { id: `repo:${fullName}`, label: fullName },
      // Granular issues (#311): one node per PlanIssue belonging to this repo (its
      // `repo`, or the default repo when unset).
      issues: planIssues
        .filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0)
        .map((iss, idx) => ({ id: `issue:${fullName}:${iss.ref ?? idx}`, label: iss.title })),
    })),
    streams: (fleet?.streams ?? []).map(st => ({
      id:     `stream:${st.id}`,
      label:  st.name,
      repo:   st.repo,
      issues: st.issues,
    })),
  };
}
