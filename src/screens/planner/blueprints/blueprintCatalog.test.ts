import { describe, it, expect } from "vitest";
import { STAGE_KINDS, STAGE_KIND_KEYS, stageKind } from "./blueprintCatalog";
import { ICONS } from "./blueprintIcons";
import { SECTION_DEFS } from "../stages/blueprints";

describe("STAGE_KINDS ↔ project-pane stage coverage", () => {
  // Every planning stage that has a SECTION_DEF (= one project pane) must map to a real icon, so a
  // blueprint card / editor / stepper never falls through to the generic `category` square for a
  // first-class stage. This guards the "imported blueprint icons don't render" regression.
  it("maps every SECTION_DEFS key to an icon present in the ICONS set", () => {
    const missing = Object.keys(SECTION_DEFS).filter((key) => !(key in STAGE_KINDS));
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
