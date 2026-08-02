// Both console mounts render the SAME copy (#4200, epic #3604).
//
// #4186 pointed `App.tsx` at `ConsoleGraphHost` and left `DetachedWindow` importing the file component, so
// the main window rendered `consolepage` from the graph while a torn-off tab rendered the bundled file —
// two copies of one page on screen at once, in different windows. Nothing looked wrong, because the parity
// guard keeps the two byte-identical; it would have started diverging the moment anyone edited the record.
// That is the failure this whole epic keeps producing (#4174, #4179, #4181), so it gets a test rather than
// a promise.
//
// It reads the SOURCE rather than rendering: mounting `DetachedWindow` drags in the store, the terminal
// host and a window-lifecycle dance, none of which is the thing under test. The question here is which
// symbol each mount site names, and that is answerable from the text.
import { describe, it, expect } from "vitest";
import appSource from "@/app/App.tsx?raw";
import detachedSource from "@/app/DetachedWindow.tsx?raw";

const MOUNTS = [
  { file: "App.tsx", source: appSource },
  { file: "DetachedWindow.tsx", source: detachedSource },
];

describe("the console is mounted from the graph in BOTH windows (#4200)", () => {
  it.each(MOUNTS)("$file renders ConsoleGraphHost", ({ source }) => {
    expect(source).toContain("<ConsoleGraphHost");
    // …and not the file component, which stays exported for its tests. Both copies coexist by design; the
    // parity guard is what keeps them from drifting apart.
    expect(source).not.toContain("<ConsoleWorkspace");
  });

  it("the tear-off forwards its tab index through the host", () => {
    // A detached window renders exactly ONE tab and says which. If the override stops reaching the graph
    // page, every torn-off window silently shows tab 0 — a wrong-but-plausible screen, the kind that gets
    // noticed weeks later.
    expect(detachedSource).toMatch(/<ConsoleGraphHost\s+tabIdxOverride=\{detachIdx\}/);
  });
});
