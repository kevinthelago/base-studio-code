import { describe, it, expect } from "vitest";
import {
  filterBlueprints, makeBlueprints, resolveProjectSeed, refreshBuiltIns, RETIRED_BLUEPRINT_IDS,
  type Blueprint,
} from "../stages/blueprints";
import { blueprintIcon, blueprintHue } from "../list/blueprintLibrary.helpers";

const bp = (id: string, name: string, over: Partial<Blueprint> = {}): Blueprint =>
  ({ id, name, desc: "", sections: [], ...over });

describe("the built-in blueprint library (#645/#3785)", () => {
  it("carries no lifecycle category — that left the blueprint model for discovery (#3785)", () => {
    // A blueprint is a goal/domain ROUTE now; lifecycle is discovered per project
    // (`ClassifyConfig.lifecycle`, #3784). Guard that nothing re-introduces the field.
    for (const b of makeBlueprints()) {
      expect(b, `${b.id} carries no category`).not.toHaveProperty("category");
    }
  });

  it("gives every built-in a DISTINCT tile glyph (#3785)", () => {
    const all = makeBlueprints();
    expect(all.find((b) => b.id === "default")!.mode).toBe("create");
    // Distinct per-domain glyphs are what replaced the one category-derived icon every card shared.
    // `blueprintIcon` is what the card actually renders: the declared `icon`, else the generic
    // grid — so `default` (the blank route, which declares none) reads as generic, by design.
    const icons = all.map(blueprintIcon);
    expect(new Set(icons).size, `distinct glyphs: ${icons.join(", ")}`).toBe(all.length);
  });

  it("drops RETIRED blueprint ids, so a stale config mirror cannot resurrect one (#3840)", () => {
    // Deleting the packaged JSON is not enough: `overlayGlob` APPENDS any config-dir file whose stem
    // it does not recognise, so an orphaned mirror copy re-introduces the blueprint on every install
    // that once shipped it — and `refreshBuiltIns` then treats it as code-owned. The tombstone is
    // what actually retires an id.
    const ids = makeBlueprints().map((b) => b.id);
    for (const dead of RETIRED_BLUEPRINT_IDS) {
      expect(ids, `${dead} is retired`).not.toContain(dead);
    }
    // …and a persisted copy is pruned from the store, not just hidden from the fresh library.
    const persisted = RETIRED_BLUEPRINT_IDS.map((id) =>
      ({ id, name: id, desc: "", origin: "built-in" as const, sections: [] }));
    const kept = refreshBuiltIns(persisted).map((b) => b.id);
    for (const dead of RETIRED_BLUEPRINT_IDS) expect(kept).not.toContain(dead);
  });

  it("gives every built-in a DISTINCT tile COLOUR (#3838)", () => {
    // The glyph alone was doing all the work: no packaged blueprint declared `h`, so every card
    // fell through to `blueprintHue`'s single fallback and all six tiles rendered the same amber.
    // (Older than #3823 — before it the colour came from the equally-degenerate `category`, which
    // was "greenfield" on every built-in.) A new blueprint without a hue must fail here, loudly,
    // rather than silently joining the fallback.
    const all = makeBlueprints();
    for (const b of all) expect(b.h, `${b.id} declares an accent hue`).toBeTypeOf("number");
    const hues = all.map((b) => blueprintHue(b.h));
    expect(new Set(hues).size, `distinct colours: ${hues.join(", ")}`).toBe(all.length);
  });

  it("the default blueprint's deployment stage is enabled so it shows in the plan (#672/#1914)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const deployment = def.sections.find((s) => s.key === "deployment")!;
    expect(deployment.enabled).toBe(true);
  });

  it("the default blueprint's UI + skills stages are optional; source/mcps/automations are required (#3785/#3905)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    // ui (and market) stay optional — hidden until the project needs them.
    expect(def.sections.find((s) => s.key === "ui")!.optional).toBe(true);
    // #3905: skills JOINED them. It was non-optional, so its gate blocked triage on any project that
    // had attached no skills — and there is nothing to confirm on an empty stage. It self-enables
    // instead: `needsSkills || projectSkillCount > 0` in usePlanGates, so attaching any skill brings
    // the stage back. Optional here means "not a gate", not "unreachable".
    expect(def.sections.find((s) => s.key === "skills")!.optional).toBe(true);
    // #3785: Default absorbed Complete's advanced stages. These stay non-optional — hidden by default
    // via their `appliesWhen` signals rather than the `optional` flag.
    for (const key of ["source", "mcps", "automations"]) {
      const sec = def.sections.find((s) => s.key === key);
      expect(sec, `default has ${key}`).toBeTruthy();
      expect(sec!.optional, `${key} is not optional`).not.toBe(true);
    }
  });

  it("refreshBuiltIns updates stale persisted built-ins but keeps user blueprints (#677)", () => {
    // a stale persisted built-in (UI not yet optional) + a user blueprint
    const stale: Blueprint = { id: "default", name: "Default", desc: "old", origin: "built-in",
      sections: [{ uid: "x", key: "ui", name: "UI", glyph: "▣", icon: "design_services", hue: 350, gate: "", deps: [], blurb: "", prompt: "", enabled: true, expanded: false }] };
    const mine: Blueprint = { id: "mine", name: "Mine", desc: "", origin: "local", sections: [] };
    const out = refreshBuiltIns([stale, mine]);
    // the built-in is refreshed from code → UI optional again
    expect(out.find((b) => b.id === "default")!.sections.find((s) => s.key === "ui")!.optional).toBe(true);
    // the user blueprint's content is preserved (refreshBuiltIns now canonicalizes section keys, #1914,
    // so it's a content-equal copy rather than the same reference)
    expect(out.find((b) => b.id === "mine")).toStrictEqual(mine);
    // #3785 made `default` the greenfield superset; #3783 adds the domain greenfields. refreshBuiltIns
    // refreshes the persisted `default` and APPENDS the new code-owned built-ins (ordered by `order`).
    expect(out.filter((b) => b.origin === "built-in").map((b) => b.id))
      .toEqual(["default", "crm", "erp", "helpdesk", "hr", "project-management"]);
  });

  it("prunes persisted built-ins that no longer exist in code, keeps user blueprints (#923)", () => {
    // a removed built-in (fullstack) lingering in the persisted store + a user blueprint
    const removed: Blueprint = { id: "fullstack", name: "Full-stack", desc: "", origin: "built-in", sections: [] };
    const mine: Blueprint = { id: "mine", name: "Mine", desc: "", origin: "local", sections: [] };
    const out = refreshBuiltIns([removed, mine]);
    expect(out.some((b) => b.id === "fullstack")).toBe(false); // pruned
    expect(out.find((b) => b.id === "mine")).toStrictEqual(mine); // user blueprint content preserved (#1914)
  });

  it("tags every built-in blueprint origin=built-in (#658)", () => {
    const all = makeBlueprints();
    expect(all.every((b) => b.origin === "built-in")).toBe(true);
    // The packaged set after #3785 consolidation + #3783: the greenfield superset Default plus the
    // five domain greenfields. (Complete + the transform/harden/data blueprints were merged in / archived.)
    for (const id of ["default", "crm", "erp", "helpdesk", "hr", "project-management"]) {
      expect(all.find((b) => b.id === id)!.origin, id).toBe("built-in");
    }
  });
});

describe("resolveProjectSeed — blueprint tracking for the reset prompt (#647 fix)", () => {
  it("a brand-new project (no config) seeds + records the active blueprint", () => {
    expect(resolveProjectSeed(false, undefined, "default")).toEqual({ seedConfig: true, setBlueprintId: "default" });
  });
  it("an existing project with NO recorded blueprint backfills to default (ignoring the active id)", () => {
    // A non-default active proves the backfill goes to `default` regardless of what's active.
    expect(resolveProjectSeed(true, undefined, "other")).toEqual({ seedConfig: false, setBlueprintId: "default" });
  });
  it("an existing project that already knows its blueprint changes nothing", () => {
    expect(resolveProjectSeed(true, "other", "default")).toEqual({ seedConfig: false });
  });
});

describe("filterBlueprints (#645, category facet dropped in #3785)", () => {
  const list = [
    bp("a", "Default", { desc: "balanced start" }),
    bp("b", "Refactor & Cleanup", { tags: ["dead-code"] }),
    bp("c", "Harden security"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterBlueprints(list, {})).toHaveLength(3);
    expect(filterBlueprints(list, { query: "  " })).toHaveLength(3);
  });
  it("filters by free-text across name/desc/tags", () => {
    expect(filterBlueprints(list, { query: "refactor" }).map((b) => b.id)).toEqual(["b"]);
    expect(filterBlueprints(list, { query: "dead-code" }).map((b) => b.id)).toEqual(["b"]); // tag
    expect(filterBlueprints(list, { query: "harden" }).map((b) => b.id)).toEqual(["c"]); // name
    expect(filterBlueprints(list, { query: "balanced" }).map((b) => b.id)).toEqual(["a"]); // desc
  });
  it("is case-insensitive", () => {
    expect(filterBlueprints(list, { query: "REFACTOR" }).map((b) => b.id)).toEqual(["b"]);
  });
});
