import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider, useResolvedTheme } from "./ThemeProvider";

/** A consumer that surfaces the resolved theme onto DOM attributes so the test can read them. */
function Probe() {
  const { themeId, tokens } = useResolvedTheme();
  return <div data-theme={themeId} data-cardbg={tokens["--card-bg"]} />;
}

describe("ThemeProvider / useResolvedTheme (#3715)", () => {
  it("provides the active theme's concrete token values to a subtree", () => {
    const { container } = render(
      <ThemeProvider themeId="nord">
        <Probe />
      </ThemeProvider>,
    );
    const el = container.querySelector("div")!;
    expect(el.getAttribute("data-theme")).toBe("nord");
    // --card-bg = var(--bg-panel); nord overrides --bg-panel → resolves to nord's value.
    expect(el.getAttribute("data-cardbg")).toBe("#323947");
  });

  it("falls back to the base theme with NO provider (standalone)", () => {
    const { container } = render(<Probe />);
    const el = container.querySelector("div")!;
    expect(el.getAttribute("data-theme")).toBe("default");
    expect(el.getAttribute("data-cardbg")).toBe("oklch(0.17 0.005 250)");
  });

  it("defaults to the base theme when themeId is omitted", () => {
    const { container } = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(container.querySelector("div")!.getAttribute("data-theme")).toBe("default");
  });
});
