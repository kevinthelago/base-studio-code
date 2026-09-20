// useScreenDescriptor (`the-shared-navigation-mechanism-drill-select-and-show`) — how a mounted page tells
// `bsc app go` what is on screen and how to move within it.
//
// WHY A DESCRIPTOR AND NOT THE STORE
// `bsc app go` could switch a workspace and a page and nothing else. A page's SELECTION and its deeper
// graph layers are local React state — Glance's crate and feature layers, the selected Teams position,
// the Algorithms inspector — so a session could land on Glance but never drill into a project or select a
// node, and could only photograph whatever a person had last clicked.
//
// Lifting every one of those into the store would change seven pages' state model and make it PERSISTED,
// which the agent view (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`) must not
// be: its navigation may not move the user's saved view. So the page PUBLISHES instead — what it rendered,
// what can be drilled or selected, and the handlers a click would run — and the navigate bridge reads it.
// Page-local state is already per window and never persisted, which is exactly what the agent view needs.
//
// WHY THIS IS A FILE AND NOT A RECORD
// It holds MODULE STATE (the registry below) on a specifier the page records resolve through the platform
// registry (`appModules`). A record there would be a second copy of that state for every graph-loaded
// page, and `bsc algorithms impl set` refuses exactly that shape. One module, one registry.
//
// THE CONTRACT
// - Published from an EFFECT, so what is registered is what COMMITTED. A reader sees the view that
//   rendered, never the one a setter was just asked for; the bridge waits for the published view to
//   change before it reports.
// - One descriptor per workspace. A page kept mounted off screen may leave its descriptor in place; the
//   bridge only ever reads the ACTIVE workspace's.
// - The handlers are the page's OWN click handlers, so a navigated drill does what a click does,
//   including refusing — `enter` returns the reason, and the page does whatever its click does instead.
import { useEffect, useRef } from "react";

/** One thing on the page a session can drill into or select. */
export interface ScreenTarget {
  id: string;
  label: string;
  drillable: boolean;
  selectable: boolean;
}

/** One level of the drill path — an id to address it by, a label to read it by. */
export interface ScreenStep {
  id: string;
  label: string;
}

export interface ScreenDescriptor {
  /** The rail key of the workspace publishing this. */
  workspace: string;
  /** The page tab this view belongs to, when the workspace has tabs. */
  page?: string;
  /** The graph layer on screen, in the page's own words (`network` · `project` · `crate` · `team` …). */
  layer?: string;
  /** False while the layer's data is still loading — its targets are not yet the real set, so a reader
   *  must wait rather than refuse an id that is about to exist. */
  ready?: boolean;
  /** The path from the workspace's top to the layer on screen; `[]` at the top. */
  drill: ScreenStep[];
  /** The target id the page shows as selected. */
  selection: string | null;
  targets: ScreenTarget[];
  /** Absent when this view has nothing to select. `null` clears. */
  select?: (id: string | null) => void;
  /** Enter a drillable target. Returns the reason when the page declines — having done whatever its click
   *  does instead — and nothing when it entered. */
  enter?: (id: string) => string | undefined;
  /** Step out one level, as the page's own back button does. */
  back?: () => void;
}

const screens = new Map<string, ScreenDescriptor>();
const pageTabs = new Map<string, string[]>();

/** The registry's read side, and the tab half of it that `usePageTabs` writes. One object rather than a
 *  row of free functions: it is one registry, and its readers should not be able to reach it any other
 *  way. */
export const navScreens = {
  /** The descriptor the workspace last COMMITTED, if it is mounted. */
  read: (workspace: string): ScreenDescriptor | undefined => screens.get(workspace),
  /** The tab ids a workspace RENDERED last, if it has mounted with tabs. */
  tabsOf: (pageKey: string): string[] | undefined => pageTabs.get(pageKey),
  publishTabs: (pageKey: string, ids: string[]): void => {
    pageTabs.set(pageKey, ids);
  },
};

/**
 * Publish what this page rendered. Pass `null` when the page should not be navigable (a torn-off copy).
 *
 * Called unconditionally every render, so the descriptor never lags the view; setting a map entry is the
 * whole cost. On unmount the entry is removed ONLY if it is still this page's, so a remount that already
 * published is not wiped by its predecessor's cleanup.
 */
export function useScreenDescriptor(descriptor: ScreenDescriptor | null): void {
  const mine = useRef<ScreenDescriptor | null>(null);
  useEffect(() => {
    mine.current = descriptor;
    if (descriptor) screens.set(descriptor.workspace, descriptor);
  });
  const workspace = descriptor?.workspace;
  useEffect(
    () => () => {
      if (workspace && screens.get(workspace) === mine.current) screens.delete(workspace);
    },
    [workspace],
  );
}
