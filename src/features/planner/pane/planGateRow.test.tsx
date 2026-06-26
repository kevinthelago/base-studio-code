import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PlanGateRow } from "./PlanStageBar";
import type { BlueprintSection } from "../stages/blueprints";

const sec = (over: Partial<BlueprintSection> & { key: string }): BlueprintSection => ({
  uid: `u-${over.key}`, name: over.key, glyph: "", icon: "category", hue: 250, gate: "", deps: [], blurb: "",
  prompt: "", enabled: true, expanded: false, ...over,
});

describe("PlanGateRow icons (imported-blueprint regression)", () => {
  // An imported / authored blueprint's sections can carry a blank or junk `glyph` string. The card
  // must still show a real icon for every stage — resolved through the stage→icon map by key, not
  // from the untrusted per-section glyph.
  it("renders an SVG icon per stage even when section.glyph is blank", () => {
    const { container } = render(
      <PlanGateRow sections={[sec({ key: "features" }), sec({ key: "deploy" })]} signals={{}} />,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(2);
    // Each node resolves the mapped glyph (features → task_alt: a checkmark polyline), never a
    // blank glyph or the generic fallback. (Compare structurally — the DOM expands self-closing
    // SVG tags, so an exact-string match against the ICONS source would spuriously differ.)
    expect(svgs[0].querySelector('polyline[points="9 11 12 14 22 4"]')).toBeTruthy();
  });

  it("falls back to the category icon for an unknown stage key — never an empty node", () => {
    const { container } = render(
      <PlanGateRow sections={[sec({ key: "totally-made-up", glyph: "" })]} signals={{}} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    // The category fallback is the 4-square grid (four <rect>s).
    expect(svg!.querySelectorAll("rect").length).toBe(4);
  });
});
