// Project-scoped store-map registry (#2712).
//
// The same long list of per-project store maps (`Record<projectKey, …>`) used to be hand-enumerated
// at FOUR sites that had to stay in sync:
//   - `deleteLocalProject`        (slices/projects.ts) — drop a SET of project keys from every map
//   - `rekeyProjectData`          (slices/projects.ts) — move oldKey → newKey (target-wins)
//   - `applyBlueprintToProject`   (slices/plan.ts)     — drop ONE project key (re-seed reset)
//   - `clearPlan`                 (slices/plan.ts)     — drop ONE project key
//
// The four sites cover **slightly different subsets** — e.g. `clearPlan` resets the plan maps but not
// the per-project preference maps (`autoTriage`, drafts, …); only `rekeyProjectData` touches
// `planFleetTopology`; only the plan.ts sites touch `reposPublic` / `stagePreview`.
// This file is the ONE source of truth: each map declares exactly which of the four operations it
// participates in, and the generic helpers below drive all four ops from it — so the subsets can no
// longer drift, while each op's exact set is preserved byte-for-byte.

import type { AppStore } from "../types";
import { deleteMapEntry, deleteMapEntries } from "../updateHelpers";

/** The four project-scoped mutations, each with its own subset of the maps below. */
export type ProjectMapOp = "delete" | "rekey" | "applyBlueprint" | "clearPlan";

// A map is opaque here — the values differ per map, but every op is key-only (drop/move by
// projectKey), so the value type is irrelevant to this module.
type AnyMap = Record<string, unknown>;

/**
 * Per-project maps keyed by the bare `projectKey`, with the set of operations that touch each.
 * Cross-check against the four call sites; add none, drop none. The union of these keys is the
 * complete set of `Record<projectKey, …>` maps any of the four project-scoped ops mutates.
 */
const PROJECT_MAP_OPS: Partial<Record<keyof AppStore, ProjectMapOp[]>> = {
  planStages:              ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planConfirmedStages:     ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planAuthoredBlueprint:   ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planDeployConfig:        ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planMarketConfig:        ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planTransformations:     ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planSkippedStages:       ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planAutomations:         ["delete", "rekey", "applyBlueprint", "clearPlan"],
  uiScreens:               ["delete", "rekey", "applyBlueprint", "clearPlan"],
  uiApproved:              ["delete", "rekey", "applyBlueprint", "clearPlan"],
  planFleet:               ["delete", "rekey", "applyBlueprint", "clearPlan"],
  pinnedContext:           ["delete", "rekey", "applyBlueprint", "clearPlan"],
  issueLinks:              ["delete", "rekey", "applyBlueprint", "clearPlan"],
  projectLocalRepos:       ["delete", "rekey", "applyBlueprint", "clearPlan"],
  // planStageConfig / projectBlueprintId are DROPPED by delete/rekey/clearPlan, but applyBlueprint
  // RE-SEEDS them (setMapEntry) instead of dropping — so they are NOT in its op set.
  planStageConfig:         ["delete", "rekey", "clearPlan"],
  projectBlueprintId:      ["delete", "rekey", "clearPlan"],
  // Plan-config maps the plan.ts sites reset; rekey also moves them, delete drops them via… no —
  // planSourceConfig is NOT in deleteLocalProject's set (only rekey + the two plan.ts reset sites).
  planSourceConfig:        ["rekey", "applyBlueprint", "clearPlan"],
  // Only the two plan.ts reset sites touch these (never delete/rekey).
  reposPublic:             ["applyBlueprint", "clearPlan"],
  planInjectionAck:        ["applyBlueprint", "clearPlan"],
  stagePreview:            ["applyBlueprint", "clearPlan"],
  stageRuns:               ["applyBlueprint", "clearPlan"],
  // Per-project preference / doc maps — deleteLocalProject + rekeyProjectData only (the plan.ts
  // reset sites deliberately leave these alone).
  projectStartupPromptDoc: ["delete", "rekey"],
  autoTriage:              ["delete", "rekey"],
  triagedProjects:         ["delete", "rekey"],
  autoKitDispatch:         ["delete", "rekey"],
  localDraftProjects:      ["delete", "rekey"],
  // rekeyProjectData-only maps (delete already covers everything it needs; the plan.ts sites don't
  // reach these fleet/verification maps).
  planFleetTopology:       ["rekey"],
  planFleetDirectorDrive:  ["rekey"],
};

/**
 * Repo-scoped maps keyed by `<projectKey>::<repo>`, with the ops that touch each. Same registry,
 * different key shape (the prefix before `::` is the project key).
 */
const REPO_MAP_OPS: Partial<Record<keyof AppStore, ProjectMapOp[]>> = {
  repoStartupPromptDoc: ["delete", "rekey"],
  repoTriagePromptDoc:  ["delete", "rekey"],
  repoPublic:           ["applyBlueprint", "clearPlan"],
};

const projectMapNames = (op: ProjectMapOp): (keyof AppStore)[] =>
  (Object.keys(PROJECT_MAP_OPS) as (keyof AppStore)[]).filter((k) => PROJECT_MAP_OPS[k]!.includes(op));
const repoMapNames = (op: ProjectMapOp): (keyof AppStore)[] =>
  (Object.keys(REPO_MAP_OPS) as (keyof AppStore)[]).filter((k) => REPO_MAP_OPS[k]!.includes(op));

/** Every per-project (bare-key) map name in the registry — the full union across the four ops. */
export const PROJECT_SCOPED_MAPS = Object.keys(PROJECT_MAP_OPS) as (keyof AppStore)[];
/** Every repo-scoped (`<key>::<repo>`) map name in the registry. */
export const REPO_SCOPED_MAPS = Object.keys(REPO_MAP_OPS) as (keyof AppStore)[];

// Read a store map by name as an opaque record (the `?? {}` guards a slice missing/null in a
// long-lived persisted store — `Object.entries(undefined)` would throw and crash the app, #874).
const readMap = (s: AppStore, name: keyof AppStore): AnyMap =>
  ((s as unknown as Record<string, AnyMap>)[name] ?? {});

/** Drop the first `::`-delimited segment of `k`; the bare project key otherwise. */
const projectKeyOf = (k: string): string => {
  const idx = k.indexOf("::");
  return idx < 0 ? k : k.slice(0, idx);
};

/**
 * deleteLocalProject: drop every entry whose key (bare project maps) or key-prefix (repo maps) is in
 * `keySet`, for exactly the maps registered under the `"delete"` op.
 */
export function deleteProjectScoped(s: AppStore, keySet: Set<string>): Partial<AppStore> {
  const out: Record<string, AnyMap> = {};
  for (const name of projectMapNames("delete")) {
    out[name] = deleteMapEntries(readMap(s, name), keySet);
  }
  for (const name of repoMapNames("delete")) {
    out[name] = Object.fromEntries(
      Object.entries(readMap(s, name)).filter(([k]) => !keySet.has(projectKeyOf(k))),
    );
  }
  return out as Partial<AppStore>;
}

/**
 * rekeyProjectData: move each entry from `oldKey` → `newKey` (target-wins: an entry already under
 * `newKey` is kept, the old one dropped), for exactly the maps registered under the `"rekey"` op.
 * Repo maps re-prefix `<oldKey>::<repo>` → `<newKey>::<repo>`.
 */
export function rekeyProjectScoped(s: AppStore, oldKey: string, newKey: string): Partial<AppStore> {
  const moveKey = (m: AnyMap): AnyMap => {
    if (!(oldKey in m)) return m;
    const { [oldKey]: moved, ...rest } = m;
    return newKey in m ? rest : { ...rest, [newKey]: moved };
  };
  const moveRepo = (m: AnyMap): AnyMap => {
    const next: AnyMap = {};
    for (const [k, v] of Object.entries(m)) {
      const idx = k.indexOf("::");
      if (idx < 0 || k.slice(0, idx) !== oldKey) { next[k] = v; continue; }
      const nk = newKey + k.slice(idx);
      if (!(nk in m)) next[nk] = v;
    }
    return next;
  };
  const out: Record<string, AnyMap> = {};
  for (const name of projectMapNames("rekey")) out[name] = moveKey(readMap(s, name));
  for (const name of repoMapNames("rekey")) out[name] = moveRepo(readMap(s, name));
  return out as Partial<AppStore>;
}

/**
 * applyBlueprintToProject / clearPlan: drop the single `key` from every map registered under the
 * given single-key reset op. Repo maps drop every `<key>::<repo>` entry.
 */
export function dropProjectScoped(
  s: AppStore,
  op: "applyBlueprint" | "clearPlan",
  key: string,
): Partial<AppStore> {
  const prefix = `${key}::`;
  const out: Record<string, AnyMap> = {};
  for (const name of projectMapNames(op)) out[name] = deleteMapEntry(readMap(s, name), key);
  for (const name of repoMapNames(op)) {
    out[name] = Object.fromEntries(Object.entries(readMap(s, name)).filter(([k]) => !k.startsWith(prefix)));
  }
  return out as Partial<AppStore>;
}
