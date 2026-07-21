import { describe, it, expect } from "vitest";
import { PALETTE_GROUPS, swatchColor } from "./palette";

describe("palette (#2834)", () => {
  it("covers exactly the 14 semantic base-palette tokens every packaged theme retints", () => {
    const tokens = PALETTE_GROUPS.flatMap((g) => g.tokens.map((t) => t.token));
    expect(tokens).toEqual(
      expect.arrayContaining([
        "--bg-canvas", "--bg-panel", "--bg-elev", "--bg-elev2",
        "--fg", "--fg-muted", "--fg-dim",
        "--border", "--border-soft",
        "--accent", "--accent-dim",
        "--success", "--info", "--danger",
      ]),
    );
    expect(tokens.length).toBe(14);
    expect(new Set(tokens).size).toBe(14); // no duplicate tokens across groups
  });

  it("swatchColor uses the theme's override when set, else the live base token via var()", () => {
    expect(swatchColor({ "--accent": "#88c0d0" }, "--accent")).toBe("#88c0d0");
    expect(swatchColor({}, "--accent")).toBe("var(--accent)");
  });
});
