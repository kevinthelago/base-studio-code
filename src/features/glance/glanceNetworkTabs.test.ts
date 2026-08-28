// Glance's tab strip IS the network list — asserted against the shipped record, because that is what
// mounts. `GlanceWorkspace.tsx` is a projection source; the record is the app.
//
// jsdom cannot render this page (it pulls the whole graph stack), so these read the source the same way
// `glanceCss.test.ts` and `glanceSelection.test.ts` do. That is the honest limit: it pins the WIRING —
// which is where every regression in this area has actually been — not the pixels.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const GLANCE: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;
const LOGS: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/logs/logspage.json", "utf8"),
).srcText;
const SCREEN: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/shared/ui/ui-screen.json", "utf8"),
).srcText;
const PERSIST: string = JSON.parse(
  readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8"),
).implementations.find((i: { id: string }) => i.id === "persist.ts").code;

describe("Glance's tabs are the networks", () => {
  it("derives the strip from the store rather than a constant", () => {
    expect(GLANCE).toMatch(/networks\.map\(/);
    expect(GLANCE).toMatch(/usePageTabs\("glance", glanceTabs\)/);
  });

  it("has NO fixed tabs — every tab is a domain", () => {
    // An `All projects` lens used to sit here. A tab that is not a domain is a different kind of thing
    // wearing the same chrome, and the kitchen-sink domain already holds everything not yet organised.
    expect(GLANCE).not.toMatch(/GLANCE_FIXED_TABS/);
    expect(GLANCE).toMatch(/networks\.map\(\(n\) => \(\{ id: n\.id, label: n\.name/);
  });

  it("draws NO projects when no tab resolves, rather than falling back to all of them", () => {
    // With no all-projects lens, the old fallback would silently draw an unscoped graph under a tab
    // claiming to be one domain.
    // The CLAIM, not the formatting: the scoped list's fallback is empty rather than `allProjects`.
    // Pinning the exact indentation (as this first did) breaks on a reflow and says nothing.
    expect(GLANCE).toMatch(/const projects = useMemo\(/);
    expect(GLANCE).not.toMatch(/:\s*allProjects\s*\)/);
  });

  it("no longer carries the Fleet page — it is a dashboard, and it lives in Logs now", () => {
    expect(GLANCE).not.toMatch(/FleetGraphHost/);
    expect(LOGS).toMatch(/id: "fleet"/);
    expect(LOGS).toMatch(/tab === "fleet" && <FleetGraphHost \/>/);
    // Through the BARREL, not a deep path: the fleet modules are still glance-owned (#1545).
    expect(LOGS).toMatch(/import \{ FleetGraphHost \} from "@\/features\/glance"/);
  });

  it("stays UNCONTROLLED, so `bsc navigate page <networkId>` can reach a tab", () => {
    // The active page is read from `activePageTab["glance"]`. A controlled tab would hold the selection
    // in the component, where navigate cannot see it and a restart cannot restore it. Every other
    // entity-derived workspace states this same constraint.
    expect(GLANCE).not.toMatch(/usePageTabs\("glance",[^)]*\{\s*activeId/);
  });

  it("opens the network's architect when its tab opens", () => {
    // The lazy start: showing the tab is the declaration that the session should be warm. Without this
    // the mount built in `a-network-architect-mounts-and-runs` exists and never runs.
    expect(GLANCE).toMatch(/openNetworkArchitect\(page\)/);
  });

  it("refuses tear-off for a network tab while keeping it for the fixed pair", () => {
    // `detachedSections` matches a torn-off page against a STUDIO sectionId, which a network has none
    // of — a detached network tab would be a window whose session dock does not follow it.
    expect(GLANCE).toMatch(/onTearOff=\{\(id\) => \{ if \(!isNetworkTab\(id\)\) tearOff\(id\); \}\}/);
  });

  it("creates, renames and closes through the store, not by hand", () => {
    for (const call of ["addNetwork", "renameNetwork", "removeNetwork"]) {
      expect(GLANCE).toContain(call);
    }
  });
});

describe("the Screen primitive forwards what TabBar already implements", () => {
  it("passes onAdd / onClose / onRename through", () => {
    // TabBar has implemented all three since the console chrome needed them; Screen simply never
    // forwarded them, so every WORKSPACE tab strip was read-only while the console's was not.
    for (const prop of ["onAdd", "onClose", "onRename"]) {
      expect(SCREEN, `Screen declares ${prop}`).toMatch(new RegExp(`${prop}\\?:`));
      expect(SCREEN, `Screen forwards ${prop} to TabBar`).toMatch(new RegExp(`${prop}=\\{${prop}\\}`));
    }
  });
});

describe("the network list is not persisted", () => {
  it("stays out of the persist allowlist, because a bsc store owns it", () => {
    // `persistedState` is re-serialized on EVERY store set(); its own doc forbids putting anything a
    // `bsc` store owns and re-hydrates at boot into it. `components` (592 KB) in that list once cost
    // 110 writes ≈ 57 MB of stringify on the main thread.
    expect(PERSIST).not.toMatch(/\bnetworks\b\s*:/);
  });
});
