// The store↔file parity guard (#4246). The store is machine state, so a repo test cannot read it — what
// IS pinnable here is that the check's input set is the whole catalogue and non-vacuous, plus the
// comparison's own behaviour driven by synthetic records. Together those make "no drift reported" mean
// "nothing drifted" rather than "nothing was looked at" — the distinction #4239 was about.
import { describe, it, expect } from "vitest";
import { SHADOW_PAGES } from "./shadowPages";
import { comparableModules, storeParityDrift, explainDrift, type StoreDrift } from "./storeParity";

describe("the guard's input set (#4246)", () => {
  it("is every catalogued module that has a file, and is not vacuous", () => {
    const mods = comparableModules();
    // Non-vacuity: if the catalogue ever stopped resolving, every case would vanish and a store full of
    // drift would report clean. That silent-pass is the whole reason this file exists.
    expect(mods.length).toBeGreaterThan(80);
    const declared = SHADOW_PAGES.flatMap((p) => p.modules).filter((m) => m.file !== null).length;
    expect(mods.length).toBe(declared);
  });

  it("excludes only the modules whose file is gone, and those are the fleet records", () => {
    const compared = new Set(comparableModules().map((m) => m.recordId));
    const skipped = SHADOW_PAGES.flatMap((p) => p.modules).filter((m) => m.file === null);
    expect(skipped.length).toBeGreaterThan(0);
    // #3636 deleted the FleetPage sources, so the record is the only copy — no baseline, not a gap.
    // Stated explicitly rather than inferred, so a NEW file-less entry has to be justified here.
    expect(skipped.every((m) => m.recordId.startsWith("fleet"))).toBe(true);
    for (const m of skipped) expect(compared.has(m.recordId)).toBe(false);
  });

  it("covers every page the app renders from the graph", () => {
    const pages = new Set(comparableModules().map((m) => m.pageId));
    // Every catalogue page contributes at least one comparable module — except a page ALL of whose files
    // are gone, which today is only fleetpage.
    for (const p of SHADOW_PAGES) {
      if (p.modules.every((m) => m.file === null)) continue;
      expect(pages.has(p.pageId), `${p.pageId} has no comparable module`).toBe(true);
    }
  });
});

describe("the comparison itself", () => {
  const anyModule = comparableModules()[0];

  it("reports nothing when the store does not hold the record", async () => {
    // A record the store lacks means the app is not rendering it from the graph at all — a different
    // condition from drift, and reporting it here would be a false alarm dressed as one.
    expect(await storeParityDrift([])).toEqual([]);
  });

  it("reports nothing for a record with no srcText", async () => {
    expect(await storeParityDrift([{ id: anyModule.recordId, srcText: "" }])).toEqual([]);
  });

  /** The live case: a store copy that renders a different tree from its file. Synthetic source, because
   *  the real answer depends on the machine's store — which is exactly why this guard runs in the app. */
  it("reports a store copy whose element tree differs from the file", async () => {
    const drift = await storeParityDrift([{ id: anyModule.recordId, srcText: "export function X(){ return <div/>; }" }]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ recordId: anyModule.recordId, file: anyModule.file, pageId: anyModule.pageId });
    expect(drift[0].differing).toBeGreaterThan(0);
  });
});

describe("explainDrift", () => {
  const base: StoreDrift = { pageId: "p", recordId: "r", file: "/f.tsx", differing: 3, fileNodes: 10, graphNodes: 10 };

  /** Direction is the actionable part: a store copy with FEWER nodes than its file is missing UI, which is
   *  a different problem from one that has grown extra. "Differs" alone does not tell you which. */
  it("names the direction, not just that they differ", () => {
    expect(explainDrift({ ...base, graphNodes: 4 })).toContain("renders LESS than");
    expect(explainDrift({ ...base, graphNodes: 40 })).toContain("renders MORE than");
    expect(explainDrift(base)).toContain("differs from");
  });

  /** `differing` counts both sides with multiplicity, so it can exceed either total — a restructured page
   *  really does report 192 differing against a 130-node file. Printing both totals keeps that legible;
   *  the earlier "192 of 130" phrasing read as a bug in the guard itself. */
  it("prints both totals, so a differing count larger than either reads sanely", () => {
    expect(explainDrift(base)).toContain("3 differing (file 10 / store 10)");
    expect(explainDrift({ ...base, differing: 192, fileNodes: 130, graphNodes: 74 }))
      .toContain("192 differing (file 130 / store 74)");
  });
});
