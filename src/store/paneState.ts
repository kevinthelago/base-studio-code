// Releasing a pane's state (#pane-keyed-store-maps-are-never-pruned).
//
// The store keeps ~30 maps keyed by pane id. `closeTab` released exactly THREE of them
// (`fleetPaneStreams`, `paneCwds`, `quarantinedPanes`) — chosen in #1951 to stop the warden
// re-quarantining a closed tab's workers, i.e. picked to fix one symptom rather than as a rule. The
// rest were left, and they are persisted, so they accumulate for the life of the install.
//
// MEASURED on a real app-state.json: 95 distinct pane ids recorded, 44 referenced by open tabs — 51
// orphans, 54%. `paneWasClaude` was 72% dead entries; `panePersonas` and `paneNames` were 100% dead.
//
// 61 KB is not much on its own. Two things make it worth a chokepoint anyway: it is UNBOUNDED (pane
// ids like `debug-studio:req-163` are minted per request), and every one of those bytes rides through
// the `JSON.stringify` that `persist` performs on EVERY store `set()` — see `store/persist.ts`.
//
// An explicit list rather than "strip these ids from every object in the state": maps keyed by
// something else exist (`repoGithubTokens` is keyed `owner/name`), and the cost of wrongly deleting a
// credential is far higher than the cost of listing the maps. `paneKeyedMapNames` + its test are how
// the list is kept honest instead.

/** Every store map keyed by pane id. Kept in sync by `paneState.test.ts`, which fails when one is added. */
export const PANE_KEYED_MAPS = [
  "disabledPanes",
  "dormantPanes",
  "endedPanes",
  "fleetPaneStreams",
  "paneAttention",
  "paneCheckpointDocs",
  "paneClaudeActive",
  "paneContinue",
  "paneCwds",
  "paneDirectorDrive",
  "paneDirectorMode",
  "paneFlows",
  "paneHooks",
  "paneInitCmds",
  "paneLastActivity",
  "paneMaintaining",
  "paneModels",
  "paneNames",
  "panePermsStale",
  "panePersonas",
  "panePrProbes",
  "paneProfiles",
  "paneProviders",
  "paneRedrawNonce",
  "paneRepos",
  "paneRoleGlobs",
  "paneRoles",
  "paneSkills",
  "paneStartupPromptDocs",
  "paneStartupPromptText",
  "paneStatus",
  "paneStream",
  "paneWasClaude",
  "paneWslDistro",
  "quarantinedPanes",
] as const;

export type PaneKeyedMap = (typeof PANE_KEYED_MAPS)[number];

/**
 * Maps that LOOK pane-keyed by name but are not, with the reason — so the drift test can force a
 * decision about every new map without this list quietly swallowing one that should be pruned.
 *
 * `tunnelExtraPanes` is keyed by the REGISTERING SOURCE (`"planner"`, `"designer"`), not by pane id
 * (#801/#2497), and is transient. Pruning it by pane id would do nothing on a good day and delete a
 * source's whole mirrored set on a bad one.
 */
export const NOT_PANE_KEYED = ["tunnelExtraPanes"] as const;

/** Does `k` LOOK like a pane-keyed map? The shape the drift test enumerates. */
export function looksPaneKeyed(k: string): boolean {
  return /^pane[A-Z]/.test(k) || /Panes$/.test(k) || k === "fleetPaneStreams";
}

/**
 * Drop `ids` from every pane-keyed map in `state`, returning ONLY the maps that actually changed.
 *
 * Returning a partial is deliberate: zustand merges it, and rebuilding 30 untouched maps on every tab
 * close would replace their identities and invalidate every selector watching them — a re-render storm
 * in the name of tidying up.
 */
export function releasePaneState(
  state: Readonly<Record<string, unknown>>,
  ids: readonly string[],
): Record<string, unknown> {
  if (ids.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const name of PANE_KEYED_MAPS) {
    const map = state[name];
    if (!map || typeof map !== "object") continue;
    const src = map as Record<string, unknown>;
    // Only rebuild a map that actually holds one of these ids.
    if (!ids.some((id) => id in src)) continue;
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (!ids.includes(k)) next[k] = src[k];
    out[name] = next;
  }
  return out;
}
