// Opt-in store resets for tests (#3836).
//
// The suite has no GLOBAL store reset, and it cannot have one: statically importing `@/store` into
// `setup.ts` pulls the store into all ~670 test files' module graphs and breaks 28 tests by
// load-order side effect alone (measured — keeping the import with the reset disabled reproduces
// every one). So resets are opt-in, and live here so a test file pays for the store import only if
// it already uses the store.
//
// Reach for these in a `beforeEach`. They exist because the recurring order-dependence bug is
// always the same shape: the file resets SOME store fields but not the one the test reads, so a
// sibling test's mutation leaks forward. `--sequence.shuffle` is what exposes it.

import { useAppStore } from "@/store";

/**
 * Reset the PAGE-TAB state `usePageTabs` persists — the active tab per page key, the user's tab
 * order, and which sections are torn off.
 *
 * Any test that clicks a page tab mutates `activePageTab[pageKey]`, and every later test in the
 * file then renders THAT page instead of the default one — so an assertion about the default page
 * silently measures the wrong surface. A workspace test should call this in its `beforeEach` even
 * if it never clicks a tab itself, since a sibling might.
 */
export function resetPageTabs(): void {
  useAppStore.setState({ activePageTab: {}, pageTabOrder: {}, detachedSections: {} });
}

/**
 * Reset the per-pane fleet derivations a launch writes — the write-scope globs, the launched-stream
 * roster, and the per-pane skill/MCP assignments.
 *
 * A test that launches a fleet leaves these populated; a later test asserting on the globs of a
 * DIFFERENT project then reads the earlier launch's entries.
 */
export function resetFleetPanes(): void {
  useAppStore.setState({ paneRoleGlobs: {}, fleetPaneStreams: {}, paneSkills: {}, paneMcpServers: {} });
}
