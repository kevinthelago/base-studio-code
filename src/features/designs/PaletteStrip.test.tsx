import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaletteStrip } from "./PaletteStrip";
import { SEED_THEMES } from "./lib/themes";

describe("PaletteStrip (#2834)", () => {
  it("renders one swatch per semantic token, grouped by category", () => {
    const nord = SEED_THEMES.find((t) => t.id === "nord")!;
    const { container } = render(<PaletteStrip theme={nord} />);
    expect(container.querySelectorAll(".ds-swatch").length).toBe(14);
    expect(screen.getByText("Surfaces")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
  });

  it("a base-look theme (no overrides) still renders every swatch (base defaults)", () => {
    const base = SEED_THEMES.find((t) => t.id === "default")!;
    const { container } = render(<PaletteStrip theme={base} />);
    expect(container.querySelectorAll(".ds-swatch").length).toBe(14);
  });
});
