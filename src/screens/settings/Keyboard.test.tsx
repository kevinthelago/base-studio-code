import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { KeyboardSettings } from "./Keyboard";
import { useAppStore } from "../../store";
import { SHORTCUT_GROUPS } from "../../lib/settings/shortcuts";
import { SHORTCUT_REGISTRY } from "../../hooks/useHotkeys";

beforeEach(() => {
  useAppStore.setState({ keybindings: {} });
});

describe("KeyboardSettings", () => {
  it("renders the reference, including a fixed (non-rebindable) row", () => {
    render(<KeyboardSettings />);
    expect(screen.getByRole("heading", { name: "Keyboard" })).toBeInTheDocument();
    // A digit-range shortcut is shown read-only (no rebind button).
    expect(screen.getByText("Switch to workspace tab by number")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Rebind Switch to workspace tab/ }),
    ).not.toBeInTheDocument();
  });

  it("rebinds a console action to the captured chord and persists it", () => {
    render(<KeyboardSettings />);
    const btn = screen.getByRole("button", { name: /Rebind Toggle broadcast/ });
    fireEvent.click(btn);
    expect(screen.getByText("Press keys…")).toBeInTheDocument();

    // Press Ctrl+Alt+B.
    fireEvent.keyDown(document, { code: "KeyB", ctrlKey: true, altKey: true });

    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBe("Ctrl+Alt+KeyB");
    // The row now shows the new caps and a reset affordance.
    const row = screen.getByRole("button", { name: /Rebind Toggle broadcast/ });
    expect(within(row).getByText("B")).toBeInTheDocument();
    expect(screen.getAllByText("reset").length).toBeGreaterThan(0);
  });

  it("flags a conflict and leaves the binding unchanged", () => {
    render(<KeyboardSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Rebind Toggle broadcast/ }));
    // Ctrl+Shift+F is fullscreen-toggle's default → conflict.
    fireEvent.keyDown(document, { code: "KeyF", ctrlKey: true, shiftKey: true });

    expect(screen.getByText(/already used by/i)).toBeInTheDocument();
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("Esc cancels capture without changing anything", () => {
    render(<KeyboardSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Rebind Toggle broadcast/ }));
    fireEvent.keyDown(document, { code: "Escape" });
    expect(screen.queryByText("Press keys…")).not.toBeInTheDocument();
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("reset reverts an overridden binding to its default", () => {
    useAppStore.setState({ keybindings: { "broadcast-toggle": "Ctrl+Alt+KeyB" } });
    render(<KeyboardSettings />);
    // Per-row reset (first one) clears the override.
    fireEvent.click(screen.getAllByText("reset")[0]);
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("screen-nav and zoom rows are now rebindable (#773)", () => {
    render(<KeyboardSettings />);
    // Screen nav: "Go to Console" can be rebound.
    const navBtn = screen.getByRole("button", { name: /Rebind Go to Console/ });
    fireEvent.click(navBtn);
    fireEvent.keyDown(document, { code: "F9" });
    expect(useAppStore.getState().keybindings["screen-console"]).toBe("F9");

    // Zoom: "Increase terminal font size" can be rebound.
    const zoomBtn = screen.getByRole("button", { name: /Rebind Increase terminal font size/ });
    fireEvent.click(zoomBtn);
    fireEvent.keyDown(document, { code: "Equal", ctrlKey: true, altKey: true });
    expect(useAppStore.getState().keybindings["zoom-in"]).toBe("Ctrl+Alt+Equal");
  });

  it("rebinds a digit-range leader via the dropdown (#773 Tier 2)", () => {
    render(<KeyboardSettings />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to workspace tab by number/ });
    // Ctrl+Alt isn't a default for any range, so no conflict.
    fireEvent.change(select, { target: { value: "Ctrl+Alt" } });
    expect(useAppStore.getState().keybindings["tab-switch"]).toBe("Ctrl+Alt");
  });

  it("flags a leader conflict and leaves it unchanged", () => {
    render(<KeyboardSettings />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to workspace tab by number/ });
    // Ctrl+Shift is pane-select's leader → conflict.
    fireEvent.change(select, { target: { value: "Ctrl+Shift" } });
    expect(screen.getByText(/already used by/i)).toBeInTheDocument();
    expect(useAppStore.getState().keybindings["tab-switch"]).toBeUndefined();
  });

  it("selecting the default leader clears the override", () => {
    useAppStore.setState({ keybindings: { "tab-switch": "Alt" } });
    render(<KeyboardSettings />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to workspace tab by number/ });
    fireEvent.change(select, { target: { value: "Ctrl" } }); // tab-switch's default
    expect(useAppStore.getState().keybindings["tab-switch"]).toBeUndefined();
  });

  it("reset-all clears every override", () => {
    useAppStore.setState({
      keybindings: { "broadcast-toggle": "Ctrl+Alt+KeyB", "clear-input": "Ctrl+Alt+KeyX" },
    });
    render(<KeyboardSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Reset all to defaults/ }));
    expect(useAppStore.getState().keybindings).toEqual({});
  });
});

// Exhaustive reference rendering — consolidated from the former keyboardSettings /
// KeyboardSettings smoke tests. Renders with default bindings (keybindings: {}).
describe("KeyboardSettings — reference rendering", () => {
  it("renders the page heading and every shortcut group title", () => {
    render(<KeyboardSettings />);
    expect(screen.getByText("Keyboard")).toBeTruthy();
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByText(group.title)).toBeTruthy();
    }
  });

  it("renders every shortcut description from SHORTCUT_GROUPS", () => {
    render(<KeyboardSettings />);
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.items) {
        expect(screen.getByText(shortcut.desc)).toBeTruthy();
      }
    }
  });

  it("renders each key cap from SHORTCUT_GROUPS", () => {
    render(<KeyboardSettings />);
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.items) {
        for (const key of shortcut.keys) {
          // Some keys (e.g. "Ctrl") appear many times — just assert at least one renders.
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
