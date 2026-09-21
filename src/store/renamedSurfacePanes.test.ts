// A SURFACE-STUDIO PANE ID ENCODES ITS NOUN, so a renamed noun strands the pane.
//
// `surface-studio:noun-ui` stopped resolving the moment `ui` became `components` — the launch plan
// refuses it ("no crate drill serves `bsc ui`") and Glance's `expandNode` returns early when a node
// resolves to no pane, so the CLICK IS SILENTLY DEAD. Measured on the live snapshot: three of five
// surface panes were stranded that way while the other two kept working, which is exactly the
// "some sessions start and some don't" this was reported as.
import { describe, it, expect } from "vitest";
import { migrateRenamedSurfacePanes, RENAMED_SURFACE_PANES } from "@/store/persist";

const P = "surface-studio:noun-";

describe("a renamed noun's surface pane migrates with it", () => {
  it("moves the pane in EVERY map it is keyed in, not a named few", () => {
    // The ids are keys in five persisted maps today. Naming them here would strand the sixth the day
    // it is added, so the migration walks the snapshot — and so does this.
    const state = {
      paneWasClaude: { [`${P}ui`]: true, [`${P}fin`]: true },
      dormantPanes: { [`${P}ui`]: 1 },
      paneProfiles: { [`${P}graph`]: "p" },
      paneModels: { [`${P}studio`]: "m" },
      aMapAddedLater: { [`${P}ui`]: "x" },
    };
    migrateRenamedSurfacePanes(state, 3);
    expect(state.paneWasClaude).toEqual({ [`${P}components`]: true, [`${P}fin`]: true });
    expect(state.dormantPanes).toEqual({ [`${P}components`]: 1 });
    expect(state.paneProfiles).toEqual({ [`${P}algorithms`]: "p" });
    expect(state.paneModels).toEqual({ [`${P}snapshot`]: "m" });
    expect(state.aMapAddedLater).toEqual({ [`${P}components`]: "x" });
  });

  it("keeps a pane that is already there when three old nouns fold into one", () => {
    // `cost`, `capacity` and `llm` all became `resources`, so three old ids can name one new pane.
    // The existing one wins: it may have been configured since, and a migration must not overwrite it.
    const state = { paneModels: { [`${P}resources`]: "keep", [`${P}cost`]: "drop", [`${P}capacity`]: "drop" } };
    migrateRenamedSurfacePanes(state, 3);
    expect(state.paneModels).toEqual({ [`${P}resources`]: "keep" });
  });

  it("is one-time — a snapshot already at v4 is untouched", () => {
    const state = { paneModels: { [`${P}ui`]: "m" } };
    migrateRenamedSurfacePanes(state, 4);
    expect(state.paneModels).toEqual({ [`${P}ui`]: "m" }, "v4 already ran; re-firing would move a pane the user re-made");
  });

  it("leaves a LIVE noun's pane alone", () => {
    const state = { paneModels: { [`${P}plan`]: "m", [`${P}components`]: "m" } };
    migrateRenamedSurfacePanes(state, 3);
    expect(state.paneModels).toEqual({ [`${P}plan`]: "m", [`${P}components`]: "m" });
  });

  it("names a replacement for every retired noun, and never maps one to itself", () => {
    for (const [oldNoun, newNoun] of RENAMED_SURFACE_PANES) {
      expect(oldNoun).not.toBe(newNoun);
      expect(newNoun.length).toBeGreaterThan(0);
    }
  });
});
