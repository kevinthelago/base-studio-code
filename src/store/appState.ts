// App-state snapshot (#2272) — the pure core behind the "demoable" app-state feature: a curated,
// shareable snapshot of the store that makes every workspace look ALIVE (projects, the Glance graph,
// the libraries, per-project plans/fleets, automations), loaded on a certain occasion as a demo.
//
// The snapshot is an ALLOWLIST (`DEMOABLE_KEYS`) — this is the security boundary. It deliberately
// EXCLUDES secrets (GitHub/LLM tokens + keys), the GitHub connection + real repos, machine-specific
// state (tabs/panes/cwds/local repo paths), and pure user prefs/toggles. So a snapshot published to a
// gist can never leak a token, and loading an untrusted app-state gist can never set an arbitrary
// store field — `pickDemoable` filters an incoming payload down to exactly these keys.
//
// Pure (no React/Tauri/store access) so it's unit-testable; the store action + gist transport that
// hydrate from this land in the wiring slice.

import type { AppStore } from "./types";

/**
 * The store keys that make up a shareable app-state snapshot. Grouped by what they populate. Adding a
 * key here makes it travel in a demo; removing one drops it. NOTHING secret or machine-specific
 * belongs here (see the module header).
 */
export const DEMOABLE_KEYS = [
  // Projects + the Glance project-network graph
  "localDraftProjects", "projectLinks", "projectKeyAlias", "issueLinks", "hiddenProjectIds", "achievements",
  // Libraries (built-ins are reconciled on load; these carry the user/demo additions + selection)
  "blueprints", "activeBlueprintId", "skills", "skillGroups", "personas", "orgs", "orgZoom",
  "dataModels", "activeDataModelId", "mcpServers", "hooks",
  // Automations
  "schedules", "commands", "automations",
  // Per-project plan / fleet / UI-plan data
  "planStages", "planConfirmedStages", "planSkippedStages", "planAuthoredBlueprint", "planDeployConfig",
  "planAutomations", "planStageConfig", "projectBlueprintId", "uiScreens", "uiApproved",
  "planFleet", "planFleetTopology", "planFleetDirectorDrive", "pinnedContext", "loadVerified",
  // Agent config · startup/triage prompt docs · repo visibility · per-session skill mapping
  "agentProfiles", "configProfiles",
  "defaultStartupPromptDoc", "projectStartupPromptDoc", "repoStartupPromptDoc", "repoTriagePromptDoc",
  "reposPublic", "repoPublic", "sessionSkillOverrides", "sessionSkillGroups",
] as const;

/** A demoable store key. */
export type DemoableKey = typeof DEMOABLE_KEYS[number];

/** A curated app-state snapshot — a partial of the store, restricted to {@link DEMOABLE_KEYS}. */
export type AppStateSnapshot = Partial<Pick<AppStore, DemoableKey>>;

const DEMOABLE_SET = new Set<string>(DEMOABLE_KEYS);

/**
 * Filter an arbitrary object down to the demoable keys (present + defined). The single security
 * boundary for BOTH directions: snapshotting the store to publish, and sanitizing an untrusted gist
 * payload before it touches the store. Anything not in {@link DEMOABLE_KEYS} — a token, a machine
 * path, or a bogus injected field — is dropped.
 */
export function pickDemoable(source: unknown): AppStateSnapshot {
  if (!source || typeof source !== "object") return {};
  const o = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DEMOABLE_KEYS) {
    if (k in o && o[k] !== undefined) out[k] = o[k];
  }
  return out as AppStateSnapshot;
}

/** Produce a shareable snapshot from the current store state (allowlist-filtered). */
export function snapshotAppState(state: Partial<Pick<AppStore, DemoableKey>>): AppStateSnapshot {
  return pickDemoable(state);
}

/** Whether `key` is a demoable store key (would be included in / accepted from a snapshot). */
export function isDemoableKey(key: string): key is DemoableKey {
  return DEMOABLE_SET.has(key);
}
