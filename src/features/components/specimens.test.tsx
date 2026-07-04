import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderSpecimen } from "./specimens";
import { SEED_COMPONENTS } from "./lib/seed";

const reactUi = SEED_COMPONENTS.filter((c) => c.kitId === "react-ui");

describe("component specimens (#2305 slice 3b)", () => {
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
});
