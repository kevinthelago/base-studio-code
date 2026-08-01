import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { KeyboardCard } from "./KeyboardCard";
import { useAppStore } from "@/store";
import { SHORTCUT_GROUPS, SHORTCUT_REGISTRY } from "../lib/shortcuts";

beforeEach(() => {
  // Console-scoped rows only render while the (opt-in, #2372) Console page is on — the default suite
  // exercises the console shortcuts, so enable it. The #3575 block covers the hidden-when-off case.
  useAppStore.setState({ keybindings: {}, showConsolePage: true });
});

describe("KeyboardCard", () => {
  it("renders the reference, including a fixed (non-rebindable) row", () => {
    render(<KeyboardCard />);
    expect(screen.getByRole("heading", { name: "Keyboard" })).toBeInTheDocument();
    // A digit-range shortcut is shown read-only (no rebind button).
    expect(screen.getByText("Switch to console tab by number")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Rebind Switch to workspace tab/ }),
    ).not.toBeInTheDocument();
  });

  it("rebinds a console action to the captured chord and persists it", () => {
    render(<KeyboardCard />);
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
    render(<KeyboardCard />);
    fireEvent.click(screen.getByRole("button", { name: /Rebind Toggle broadcast/ }));
    // Ctrl+Shift+F is fullscreen-toggle's default → conflict.
    fireEvent.keyDown(document, { code: "KeyF", ctrlKey: true, shiftKey: true });

    expect(screen.getByText(/already used by/i)).toBeInTheDocument();
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("Esc cancels capture without changing anything", () => {
    render(<KeyboardCard />);
    fireEvent.click(screen.getByRole("button", { name: /Rebind Toggle broadcast/ }));
    fireEvent.keyDown(document, { code: "Escape" });
    expect(screen.queryByText("Press keys…")).not.toBeInTheDocument();
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("reset reverts an overridden binding to its default", () => {
    useAppStore.setState({ keybindings: { "broadcast-toggle": "Ctrl+Alt+KeyB" } });
    render(<KeyboardCard />);
    // Per-row reset (first one) clears the override.
    fireEvent.click(screen.getAllByText("reset")[0]);
    expect(useAppStore.getState().keybindings["broadcast-toggle"]).toBeUndefined();
  });

  it("screen-nav and zoom rows are now rebindable (#773)", () => {
    render(<KeyboardCard />);
    // Screen nav: "Go to Planner" can be rebound.
    const navBtn = screen.getByRole("button", { name: /Rebind Go to Planner/ });
    fireEvent.click(navBtn);
    fireEvent.keyDown(document, { code: "F9" });
    expect(useAppStore.getState().keybindings["screen-projects"]).toBe("F9");

    // Zoom: "Increase terminal font size" can be rebound.
    const zoomBtn = screen.getByRole("button", { name: /Rebind Increase terminal font size/ });
    fireEvent.click(zoomBtn);
    fireEvent.keyDown(document, { code: "Equal", ctrlKey: true, altKey: true });
    expect(useAppStore.getState().keybindings["zoom-in"]).toBe("Ctrl+Alt+Equal");
  });

  it("rebinds a digit-range leader via the dropdown (#773 Tier 2)", () => {
    render(<KeyboardCard />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to console tab by number/ });
    // Ctrl+Alt isn't a default for any range, so no conflict.
    fireEvent.change(select, { target: { value: "Ctrl+Alt" } });
    expect(useAppStore.getState().keybindings["tab-switch"]).toBe("Ctrl+Alt");
  });

  it("flags a leader conflict and leaves it unchanged", () => {
    render(<KeyboardCard />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to console tab by number/ });
    // Ctrl+Shift is pane-select's leader → conflict.
    fireEvent.change(select, { target: { value: "Ctrl+Shift" } });
    expect(screen.getByText(/already used by/i)).toBeInTheDocument();
    expect(useAppStore.getState().keybindings["tab-switch"]).toBeUndefined();
  });

  it("selecting the default leader clears the override", () => {
    useAppStore.setState({ keybindings: { "tab-switch": "Alt" } });
    render(<KeyboardCard />);
    const select = screen.getByRole("combobox", { name: /Leader for Switch to console tab by number/ });
    fireEvent.change(select, { target: { value: "Ctrl" } }); // tab-switch's default
    expect(useAppStore.getState().keybindings["tab-switch"]).toBeUndefined();
  });

  it("reset-all clears every override", () => {
    useAppStore.setState({
      keybindings: { "broadcast-toggle": "Ctrl+Alt+KeyB", "clear-input": "Ctrl+Alt+KeyX" },
    });
    render(<KeyboardCard />);
    fireEvent.click(screen.getByRole("button", { name: /Reset all to defaults/ }));
    expect(useAppStore.getState().keybindings).toEqual({});
  });
});

describe("KeyboardCard — reference rendering", () => {
  it("renders the page heading and every shortcut group title", () => {
    render(<KeyboardCard />);
    expect(screen.getByText("Keyboard")).toBeTruthy();
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByText(group.title)).toBeTruthy();
    }
  });

  it("renders every shortcut description from SHORTCUT_GROUPS", () => {
    render(<KeyboardCard />);
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.items) {
        expect(screen.getByText(shortcut.desc)).toBeTruthy();
      }
    }
  });

  it("renders each key cap from SHORTCUT_GROUPS", () => {
    render(<KeyboardCard />);
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

describe("KeyboardCard — console rows follow the Console-page toggle (#3575)", () => {
  // The Console-scoped groups (all items scope === "Console"); Navigation is Global and always shows.
  const consoleGroups = SHORTCUT_GROUPS.filter((g) => g.items.every((s) => s.scope === "Console"));

  it("hides the Console-scoped groups when the page is off, keeping Navigation", () => {
    useAppStore.setState({ showConsolePage: false });
    render(<KeyboardCard />);

    expect(screen.getByText("Navigation")).toBeTruthy();          // global nav stays
    // The PAGE bindings are genuinely global — they fire on every workspace (#4167).
    expect(screen.getByText("Next page in this workspace")).toBeTruthy();
    // …but the console TAB row hides with the other Console-scoped rows: it is registered inside the
    // console-gated effect, so with the page off it cannot fire, and advertising it as Global was the
    // documentation half of the "tab hotkeys do nothing" report (#4167).
    expect(screen.queryByText("Switch to console tab by number")).toBeNull();
    for (const group of consoleGroups) {
      expect(screen.queryByText(group.title)).toBeNull();         // console group titles gone
      for (const s of group.items) {
        expect(screen.queryByText(s.desc)).toBeNull();            // …and their rows
      }
    }
  });

  it("shows the Console-scoped groups when the page is on", () => {
    useAppStore.setState({ showConsolePage: true });
    render(<KeyboardCard />);
    for (const group of consoleGroups) {
      expect(screen.getByText(group.title)).toBeTruthy();
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
