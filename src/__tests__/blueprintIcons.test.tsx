import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Ic, ICONS } from "../screens/planner/blueprints/blueprintIcons";

describe("blueprint icons (#609)", () => {
  it("renders an inline SVG for a known glyph", () => {
    const { container } = render(<Ic n="flag" size={20} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe("20");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.innerHTML.length).toBeGreaterThan(0);
  });

  it("has a chevron_left glyph for the planner back button", () => {
    expect(ICONS.chevron_left).toContain("polyline");
    const { container } = render(<Ic n="chevron_left" size={18} />);
    expect(container.querySelector("svg polyline")).not.toBeNull();
  });

  it("falls back to the category glyph for an unknown name", () => {
    const { container } = render(<Ic n="does-not-exist" />);
    // category is 4 rects; assert the shape rather than exact (jsdom-serialized) markup.
    expect(container.querySelectorAll("svg rect").length).toBe(4);
    expect(ICONS.category).toContain("rect");
  });
});
