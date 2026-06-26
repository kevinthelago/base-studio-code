import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useHotkeys } from "./useHotkeys";
import { useAppStore } from "@/store";

/**
 * #1218: the global hotkey listener used to run app-wide on the capture phase, sitting in front of
 * every screen's inputs and the terminal — swallowing copy/paste. The listener is now Console-only
 * and detaches while a pane is maximized, so those surfaces get unobstructed native key behavior.
 */

/** Dispatch a keydown on document (capture phase, where useHotkeys listens) and return the event so
 *  the caller can inspect defaultPrevented. */
function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  act(() => { document.dispatchEvent(ev); });
  return ev;
}

// The default broadcast-toggle chord (Ctrl+Shift+C) — a simple hotkey that flips a store flag, so
// it's an easy probe for "did the listener fire?".
const BROADCAST_TOGGLE: KeyboardEventInit = { code: "KeyC", ctrlKey: true, shiftKey: true };

beforeEach(() => {
  useAppStore.setState({
    activeScreen: "console",
    fullscreenPaneIdx: -1,
    consoleBroadcast: false,
    keybindings: {},
  });
});

afterEach(() => cleanup());

describe("useHotkeys — Console-only listener (#1218)", () => {
  it("does not fire on a non-Console screen (no mutation, no preventDefault)", () => {
    useAppStore.setState({ activeScreen: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey(BROADCAST_TOGGLE);

    expect(useAppStore.getState().consoleBroadcast).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("does not navigate screens from off-Console (F1–F6 are Console-only now)", () => {
    useAppStore.setState({ activeScreen: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey({ code: "F1" }); // screen-console hotkey

    expect(useAppStore.getState().activeScreen).toBe("settings");
    expect(ev.defaultPrevented).toBe(false);
  });

  it("is inert while a console pane is maximized", () => {
    useAppStore.setState({ activeScreen: "console", fullscreenPaneIdx: 0 });
    renderHook(() => useHotkeys());

    const ev = pressKey(BROADCAST_TOGGLE);

    expect(useAppStore.getState().consoleBroadcast).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("fires on the normal (non-maximized) Console page", () => {
    renderHook(() => useHotkeys());

    const ev = pressKey(BROADCAST_TOGGLE);

    expect(useAppStore.getState().consoleBroadcast).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("re-attaches when returning to Console and detaches when leaving", () => {
    const { rerender } = renderHook(() => useHotkeys());

    // Leave Console → listener detaches → key is inert.
    act(() => { useAppStore.setState({ activeScreen: "github" }); });
    rerender();
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(false);
    expect(useAppStore.getState().consoleBroadcast).toBe(false);

    // Back to Console → listener re-attaches → key fires again.
    act(() => { useAppStore.setState({ activeScreen: "console" }); });
    rerender();
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(true);
    expect(useAppStore.getState().consoleBroadcast).toBe(true);
  });
});
