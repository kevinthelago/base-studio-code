import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { KeyboardSettings } from "./Keyboard";
import { useAppStore } from "../../store";

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

  it("reset-all clears every override", () => {
    useAppStore.setState({
      keybindings: { "broadcast-toggle": "Ctrl+Alt+KeyB", "clear-input": "Ctrl+Alt+KeyX" },
    });
    render(<KeyboardSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Reset all to defaults/ }));
    expect(useAppStore.getState().keybindings).toEqual({});
  });
});
