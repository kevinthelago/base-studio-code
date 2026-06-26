import { describe, it, expect } from "vitest";
import { STAGE_KINDS, STAGE_KIND_KEYS, stageKind } from "./blueprintCatalog";
import { ICONS } from "./blueprintIcons";
import { STAGE_DEFS } from "../stages/blueprints";

describe("STAGE_KINDS ↔ project-pane stage coverage", () => {
  // Every planning stage that has a SECTION_DEF (= one project pane) must map to a real icon, so a
  // blueprint card / editor / stepper never falls through to the generic `category` square for a
  // first-class stage. This guards the "imported blueprint icons don't render" regression.
  it("maps every STAGE_DEFS key to an icon present in the ICONS set", () => {
    const missing = Object.keys(STAGE_DEFS).filter((key) => !(key in STAGE_KINDS));
    expect(missing).toEqual([]);
  });

  it("only references glyphs that exist in the ICONS set", () => {
    const bad = Object.entries(STAGE_KINDS)
      .filter(([, meta]) => !(meta.glyph in ICONS))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("keeps the add-stage palette a curated subset (no data-platform / authoring internals)", () => {
    // The palette must stay user-facing — internal pipeline + meta-authoring stages have icons in
    // the map but must not be hand-addable.
    expect(STAGE_KIND_KEYS).not.toContain("dataModel");
    expect(STAGE_KIND_KEYS).not.toContain("bp_stages");
    expect(STAGE_KIND_KEYS).not.toContain("purpose");
    // …yet they still resolve a real (non-fallback) icon.
    expect(stageKind("dataModel").glyph).toBe("database");
    expect(stageKind("bp_stages").glyph in ICONS).toBe(true);
  });

  it("falls back to the category glyph only for a genuinely unknown key", () => {
    expect(stageKind("totally-made-up").glyph).toBe("category");
  });
});

describe("STAGE_KINDS derived from the stage JSON data layer (#1603)", () => {
  it("resolves every add-stage palette key — including the discovery-dimension kinds — to a real icon + hue", () => {
    // The palette mixes real stages (discovery/repos/…) with discovery-dimension kinds
    // (users/stack/architecture/…) that have NO stage file but ARE enriched in discovery.json.
    // None may fall through to the generic `category` square.
    const fellThrough = STAGE_KIND_KEYS.filter((k) => stageKind(k).glyph === "category" || !(stageKind(k).glyph in ICONS));
    expect(fellThrough).toEqual([]);
    for (const k of STAGE_KIND_KEYS) expect(typeof stageKind(k).h).toBe("number");
  });

  it("sources icon + hue from the stage's own JSON (STAGE_DEFS), separate from its unicode glyph", () => {
    expect(stageKind("discovery").glyph).toBe(STAGE_DEFS.discovery.icon);
    expect(stageKind("discovery").h).toBe(STAGE_DEFS.discovery.hue);
    expect(stageKind("discovery").glyph).toBe("flag");
  });

  it("sources the dimension kinds from discovery.json dimensions", () => {
    const stack = (STAGE_DEFS.discovery.dimensions ?? []).find((d) => d.key === "stack")!;
    expect(stack.icon).toBeTruthy();
    expect(stageKind("stack").glyph).toBe(stack.icon);
    expect(stageKind("stack").h).toBe(stack.hue);
  });

  it("reconciles the palette title to the stage's JSON name (option A)", () => {
    // Formerly the palette title diverged from the stage bar; now it's single-sourced to `name`.
    expect(stageKind("structure").title).toBe("Plan");
    expect(stageKind("repos").title).toBe("Repos");
    expect(stageKind("structure").title).toBe(STAGE_DEFS.structure.name);
  });
});
