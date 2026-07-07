import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderSpecimen } from "./specimens";
import { SEED_COMPONENTS } from "./lib/seed";

const reactUi = SEED_COMPONENTS.filter((c) => c.kitId === "react-ui");

describe("component specimens (#2305 slice 3b)", () => {
  it("renders a shimmer skeleton for the `loading` variant, riding the app's motion keyframe (#2302)", () => {
    for (const name of ["Card", "Chip", "Text", "FillBar", "Code"]) {
      const c = reactUi.find((x) => x.name === name)!;
      const { container, unmount } = render(<>{renderSpecimen(c, "loading", "dark")}</>);
      // `.ds-skel` carries the shared `skeleton-shimmer` keyframe (designStudio.css) + the reduced-motion
      // opt-out, so the loading state uses the app's ONE motion vocabulary rather than a bespoke shimmer.
      expect(container.querySelector(".ds-skel"), `${name} loading specimen has a .ds-skel shimmer`).toBeTruthy();
      unmount();
    }
  });

  it("every react-ui primitive has a bespoke specimen (never the fallback placeholder)", () => {
    for (const c of reactUi) {
      const { container, unmount } = render(<>{renderSpecimen(c, c.variants[0] ?? "default", "dark")}</>);
      // The default branch prints "<role> · rendered in-app" — a registered primitive must not hit it.
      expect(container.textContent ?? "", `${c.name} falls back to the placeholder`).not.toContain("rendered in-app");
      unmount();
    }
  });

  it("renders each primitive in both preview themes without throwing", () => {
    for (const c of reactUi) {
      for (const theme of ["dark", "light"] as const) {
        expect(() => {
          const { unmount } = render(<>{renderSpecimen(c, c.variants[0] ?? "default", theme)}</>);
          unmount();
        }, `${c.name} (${theme})`).not.toThrow();
      }
    }
  });

  it("renders a live schematic for every Layouts-tier template + variant (#2197 slice 3)", () => {
    const layouts = reactUi.filter((c) => c.role === "layout" && (c.tags ?? []).includes("page"));
    // The six page-skeleton templates must all be present and each must render a bespoke schematic
    // (never the fallback placeholder) for every registered variant, in both preview themes.
    expect(layouts.map((c) => c.name).sort()).toEqual(["GraphCanvas", "MasterDetail", "PaneGrid", "Sequence", "SplitView", "Tree"]);
    for (const c of layouts) {
      for (const variant of c.variants) {
        for (const theme of ["dark", "light"] as const) {
          const { container, unmount } = render(<>{renderSpecimen(c, variant, theme)}</>);
          expect(container.textContent ?? "", `${c.name} · ${variant} · ${theme}`).not.toContain("rendered in-app");
          unmount();
        }
      }
    }
  });
});
