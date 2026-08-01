// The mounted Screen's live PageTabs, for the app shell's keyboard owner (#4167, fixed #4170).
//
// WHY A MODULE REF AND NOT STORE STATE. #4167 published this into the Zustand store and that caused an
// infinite render loop on the Planner (`Maximum update depth exceeded`):
//
//   PlannerWorkspace subscribes to the WHOLE store (`useAppStore()` with no selector), and passes a fresh
//   inline arrow as its controlled `setActive` — so `select` has a new identity every render. The publish
//   effect listed `onSelect` in its deps, its idempotency guard compared `cur.select === nav.select` (which
//   a fresh arrow can never satisfy), and the resulting store write re-rendered every subscriber, including
//   the Planner. Publish → write → re-render → new identity → publish.
//
// The root mistake was putting a CALLBACK in the store: a write whose idempotency depends on function
// identity is not idempotent. And the reactivity was never needed — the keyboard handler reads this at
// keydown time, not during render. A module ref removes the whole class: no store write, no subscribers,
// no loop possible, and an unstable `select` identity costs nothing.
//
// A torn-off page runs in its own window and therefore its own module instance, so there is no sharing to
// coordinate. Exactly one Screen is mounted per window.

/** The active Workspace's page strip + its selector. `null` when no tabbed Workspace is on screen (the
 *  Console page, which does not render through `Screen`, or a torn-off single Page). */
export interface PageNav {
  ids: string[];
  active: string;
  select: (id: string) => void;
}

let current: PageNav | null = null;

/** Publish the mounted Screen's page model (or `null` to clear on unmount / a torn-off page). */
export function setPageNav(nav: PageNav | null): void {
  current = nav;
}

/** Read the live page model — called at keydown time by the shell's hotkey handler. */
export function getPageNav(): PageNav | null {
  return current;
}
