import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyboardSettings } from "../../screens/settings/Keyboard";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { SHORTCUT_REGISTRY } from "../../hooks/useHotkeys";

describe("KeyboardSettings smoke", () => {
  it("renders the heading", () => {
    render(<KeyboardSettings />);
    expect(screen.getByText("Keyboard")).toBeInTheDocument();
  });

  it("renders all group titles from SHORTCUT_GROUPS", () => {
    render(<KeyboardSettings />);
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByText(group.title)).toBeInTheDocument();
    }
  });

  it("renders every shortcut description from SHORTCUT_GROUPS", () => {
    render(<KeyboardSettings />);
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.items) {
        expect(screen.getByText(shortcut.desc)).toBeInTheDocument();
      }
    }
  });

  it("renders each key cap from SHORTCUT_GROUPS", () => {
    render(<KeyboardSettings />);
    // Each key in the keys array is rendered as a separate <kbd> element
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.items) {
        for (const key of shortcut.keys) {
          // Some keys appear multiple times (e.g. "Ctrl") — just verify at least one
          expect(screen.getAllByText(key).length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("SHORTCUT_REGISTRY integrity", () => {
  it("has no duplicate ids", () => {
    const ids = SHORTCUT_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty label, keys, and description", () => {
    for (const s of SHORTCUT_REGISTRY) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("context values are either undefined or 'Console'", () => {
    for (const s of SHORTCUT_REGISTRY) {
      expect(s.context === undefined || s.context === "Console").toBe(true);
    }
  });
});
