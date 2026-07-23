// The packaged seed + its hash-based reconcile (#2483), against the clean-slate seed (#3543): ONE empty
// `base-studio-code` kit. These cover the reconcile MECHANICS the built-in-rot incidents needed (stamp
// self-consistency, retire-on-leave, legacy no-hash refresh, keep-user-edit) plus the wipe itself.
import { describe, it, expect } from "vitest";
import type { ComponentRecord, Kit } from "./model";
import { SEED_COMPONENTS, SEED_KITS, BASE_STUDIO_CODE_KIT_ID, reconcileComponents, reconcileKits } from "./seed";
import { seedHashOf, stampSeedHash } from "./seedRefresh";

/** A prior packaged kit, stamped pristine — the kind of record the reconcile must now retire (#3543). */
const priorKit = (id: string): Kit =>
  stampSeedHash({ id, name: id, tech: "react", style: "studio", stack: id, dot: "green", builtin: true } as Kit);

describe("the clean-slate seed (#3543)", () => {
  it("is the one base-studio-code kit, now carrying the migrated app-page components (#3543/#3604)", () => {
    expect(SEED_KITS.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]);
    expect(SEED_KITS[0].animations).toEqual([]);
    // No longer empty (#3604): the kit fills as the code UI migrates into the graph — every seeded
    // component belongs to base-studio-code, is a stamped built-in, and fleetpage led the way.
    expect(SEED_COMPONENTS.length).toBeGreaterThan(0);
    expect(SEED_COMPONENTS.every((c) => c.kitId === BASE_STUDIO_CODE_KIT_ID && c.builtin)).toBe(true);
    expect(SEED_COMPONENTS.map((c) => c.id)).toContain("fleetpage");
    // tech "react" is load-bearing: themes bind to the design group by tech, not kit id.
    expect(SEED_KITS[0].tech).toBe("react");
  });

  it("the packaged kit carries a self-consistent seedHash (#2483)", () => {
    expect(SEED_KITS[0].builtin).toBe(true);
    expect(SEED_KITS[0].seedHash).toBe(seedHashOf(SEED_KITS[0]));
  });
});

describe("the wipe — the reconcile retires every prior packaged kit (#3543)", () => {
  it("a store full of the OLD pristine kits converges to just base-studio-code", () => {
    // The six kits this replaced (react-ui/fleet/base/algo-viz/matrix-viz/graph-viz), all pristine.
    const old = ["react-ui", "fleet", "base", "algo-viz", "matrix-viz", "graph-viz"].map(priorKit);
    const r = reconcileKits(old);
    expect(r.records.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]); // only the new kit survives
    expect(r.drops.sort()).toEqual(["algo-viz", "base", "fleet", "graph-viz", "matrix-viz", "react-ui"]);
    expect(r.notices).toEqual([]); // pristine retirement is silent — no orphaned notice
  });

  it("seeds the empty kit into a blank store (fresh install)", () => {
    const r = reconcileKits([]);
    expect(r.records.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]);
    expect(r.pushes.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]);
  });

  it("drops a prior pristine component AND seeds the migrated app pages (#3604)", () => {
    const staleComp = stampSeedHash<ComponentRecord>({
      id: "old-button", name: "Button", kitId: "react-ui", role: "primitive", version: "1", used: 0,
      tags: [], variants: [], composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "", builtin: true,
    });
    const r = reconcileComponents([staleComp]);
    expect(r.drops).toEqual(["old-button"]); // the retired pristine built-in still goes
    // the migrated seed components are appended + pushed (the fresh-install add path)
    const seededIds = SEED_COMPONENTS.map((c) => c.id).sort();
    expect(r.records.map((c) => c.id).sort()).toEqual(seededIds);
    expect(r.pushes.map((c) => c.id).sort()).toEqual(seededIds);
  });

  it("KEEPS a user-edited prior kit, surfacing an orphaned notice (store wins, #2483)", () => {
    // A kit the designer hand-edited (its recorded hash is not the current seed's) is not silently wiped.
    const edited: Kit = { ...priorKit("react-ui"), stack: "my custom stack", seedHash: "00000000" };
    const r = reconcileKits([edited]);
    expect(r.records.find((k) => k.id === "react-ui")).toEqual(edited); // kept verbatim
    expect(r.drops).not.toContain("react-ui");
    expect(r.notices).toContainEqual({ kind: "orphaned", type: "kit", id: "react-ui", name: "react-ui" });
  });

  it("legacy no-hash records refresh once, then a re-hydrate is a no-op", () => {
    const legacy: Kit[] = SEED_KITS.map((k) => ({ ...k, seedHash: undefined }));
    const r = reconcileKits(legacy);
    expect(r.records).toEqual(SEED_KITS); // refreshed to the stamped copy
    expect(r.pushes).toEqual(SEED_KITS);
    const again = reconcileKits(SEED_KITS);
    expect(again.pushes).toEqual([]);
    expect(again.records).toEqual(SEED_KITS);
  });
});
