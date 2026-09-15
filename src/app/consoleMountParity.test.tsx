// The console is mounted from the graph, and ONLY in the main window (#4200, epic #3604).
//
// #4186 pointed `App.tsx` at `ConsoleGraphHost` and left `DetachedWindow` importing the file component, so
// the main window rendered `consolepage` from the graph while a torn-off tab rendered the bundled file —
// two copies of one page on screen at once, in different windows. That is the failure this whole epic keeps
// producing (#4174, #4179, #4181), so it gets a test rather than a promise.
//
// A torn-off CONSOLE TAB is gone since `project-fleet-panes-live-only-in-glance`: the console hosts only
// system sessions and a project's panes live in Glance, so there is no tab to tear off and the detached
// window mounts no console at all.
//
// It reads the SOURCE rather than rendering: mounting `DetachedWindow` drags in the store, the terminal
// host and a window-lifecycle dance, none of which is the thing under test. The question here is which
// symbol each mount site names, and that is answerable from the text.
import { describe, it, expect } from "vitest";
import appSource from "@/app/App.tsx?raw";
import detachedSource from "@/app/DetachedWindow.tsx?raw";

describe("the console is mounted from the graph in the main window only (#4200)", () => {
  it("App.tsx renders ConsoleGraphHost, not the file component", () => {
    expect(appSource).toContain("<ConsoleGraphHost");
    // …and not the file component, which stays exported for its tests.
    expect(appSource).not.toContain("<ConsoleWorkspace");
  });

  it("the detached window mounts no console and pins no tab", () => {
    // It used to render `<ConsoleGraphHost tabIdxOverride={detachIdx} />` for a torn-off console tab. There is
    // no console tab to pin now, so neither the host nor the override may come back.
    expect(detachedSource).not.toContain("<ConsoleGraphHost");
    expect(detachedSource).not.toContain("<ConsoleWorkspace");
    expect(detachedSource).not.toContain("tabIdxOverride");
    expect(detachedSource).not.toContain("detachedTabId");
  });
});
