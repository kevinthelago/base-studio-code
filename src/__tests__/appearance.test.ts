import { describe, it, expect } from "vitest";
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentVars } from "../lib/appearance";

describe("accentVars", () => {
  it("maps a known accent id to a matching --accent / --accent-dim oklch pair", () => {
    const blue = ACCENT_PRESETS.find((p) => p.id === "blue")!;
    expect(accentVars("blue")).toEqual({
      accent: `oklch(0.80 0.14 ${blue.hue})`,
      accentDim: `oklch(0.55 0.10 ${blue.hue})`,
    });
  });

  it("falls back to the default accent for an unknown id", () => {
    expect(accentVars("does-not-exist")).toEqual(accentVars(DEFAULT_ACCENT));
  });

  it("every preset yields both token values", () => {
    for (const p of ACCENT_PRESETS) {
      const v = accentVars(p.id);
      expect(v.accent).toContain(String(p.hue));
      expect(v.accentDim).toContain(String(p.hue));
    }
  });
});
