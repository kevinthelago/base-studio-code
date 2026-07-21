import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemesMenu } from "./ThemesMenu";
import { SEED_THEMES } from "./lib/themes";

describe("ThemesMenu (#2834)", () => {
  it("groups themes by design group (#2749) and washes the active row", () => {
    const { container } = render(<ThemesMenu themes={SEED_THEMES} activeId="nord" onSelect={() => {}} />);
    // The packaged themes all bind to the `react` design group → one group header.
    expect(container.querySelectorAll(".tm-grouphead").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Nord/ }).className).toContain("on");   // active
    expect(screen.getByRole("button", { name: /^Dark/ }).className).not.toContain("on");
  });

  it("selecting a theme calls onSelect with its id (drives the preview retint)", () => {
    const onSelect = vi.fn();
    render(<ThemesMenu themes={SEED_THEMES} activeId="default" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Nord/ }));
    expect(onSelect).toHaveBeenCalledWith("nord");
  });

  it("collapsing a design group hides its theme rows", () => {
    const { container } = render(<ThemesMenu themes={SEED_THEMES} activeId="default" onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /Nord/ })).toBeTruthy();
    fireEvent.click(container.querySelector(".tm-grouphead") as HTMLElement);   // collapse `react`
    expect(screen.queryByRole("button", { name: /Nord/ })).toBeNull();
  });

  it("shows a per-row surface glyph (dark/light) from the theme's base", () => {
    render(<ThemesMenu themes={SEED_THEMES} activeId="default" onSelect={() => {}} />);
    // Light is a packaged light-surface theme → its row carries the ◑ glyph. Anchor `^Light` so it
    // matches ONLY the `light` theme, not `solarized-light` ("Solarized Light") — mirrors the `^Dark`
    // disambiguation above now that a second light-surface theme exists (base-drift, #3032).
    expect(screen.getByRole("button", { name: /^Light.*◑/ })).toBeTruthy();
  });
});
