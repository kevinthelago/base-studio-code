import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemesGallery } from "./ThemesGallery";
import { SEED_THEMES } from "./lib/themes";
import { useAppStore } from "@/store";

/** Seed the theme collection before each test (the store is a singleton). */
beforeEach(() => {
  useAppStore.setState({ kitThemes: SEED_THEMES });
});

describe("ThemesGallery (#themes-tab)", () => {
  it("renders a card per theme, with the default + built-in badges", () => {
    render(<ThemesGallery />);
    // Every packaged theme surfaces as a card (its label).
    for (const t of SEED_THEMES) expect(screen.getByText(t.label)).toBeTruthy();
    // The default theme carries the "default" badge; the packaged ones are all "built-in".
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.getAllByText("built-in").length).toBe(SEED_THEMES.length);
  });

  it("lists a theme's token overrides, and marks a base-look theme as having none", () => {
    render(<ThemesGallery />);
    // Soft/High-contrast override --card-radius — the override name renders.
    expect(screen.getAllByText("--card-radius").length).toBeGreaterThan(0);
    // Dark + Light are the base look on each surface — no overrides.
    expect(screen.getAllByText(/Base look — no token overrides/).length).toBeGreaterThanOrEqual(2);
  });

  it("shows an empty state when there are no themes", () => {
    useAppStore.setState({ kitThemes: [] });
    render(<ThemesGallery />);
    expect(screen.getByText("No themes yet")).toBeTruthy();
  });
});
