import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyboardSettings } from "../screens/settings/Keyboard";
import { SHORTCUT_GROUPS } from "../lib/shortcuts";

describe("KeyboardSettings", () => {
  it("renders the page and every shortcut group (no 'coming soon')", () => {
    render(<KeyboardSettings />);
    expect(screen.getByText("Keyboard")).toBeTruthy();
    for (const g of SHORTCUT_GROUPS) {
      expect(screen.getByText(g.title)).toBeTruthy();
    }
  });

  it("lists known shortcuts with their key caps", () => {
    render(<KeyboardSettings />);
    // A screen-nav entry derived from the registry.
    expect(screen.getByText("Go to Console")).toBeTruthy();
    expect(screen.getByText("F1")).toBeTruthy();
    // A console chord with its description.
    expect(screen.getByText(/Toggle broadcast/)).toBeTruthy();
    // Modifier caps render (more than one "Ctrl" across the catalog).
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(1);
  });
});
