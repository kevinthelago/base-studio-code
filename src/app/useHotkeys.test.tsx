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
    activeWorkspace: "console",
    fullscreenPaneIdx: -1,
    consoleBroadcast: false,
    keybindings: {},
  });
});

afterEach(() => cleanup());

describe("useHotkeys — Console-only listener (#1218)", () => {
  it("does not fire on a non-Console screen (no mutation, no preventDefault)", () => {
    useAppStore.setState({ activeWorkspace: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey(BROADCAST_TOGGLE);

    expect(useAppStore.getState().consoleBroadcast).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("navigates screens from off-Console via the always-on F-key listener (#2403)", () => {
    // #1218 accidentally made F-key screen nav Console-only; the global listener restores it everywhere.
    useAppStore.setState({ activeWorkspace: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey({ code: "F6" }); // screen-github

    expect(useAppStore.getState().activeWorkspace).toBe("github");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("F1 no longer navigates — the console screen hotkey was removed (#2403)", () => {
    useAppStore.setState({ activeWorkspace: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey({ code: "F1" });

    expect(useAppStore.getState().activeWorkspace).toBe("settings");
    expect(ev.defaultPrevented).toBe(false);
  });

  it("is inert while a console pane is maximized", () => {
    useAppStore.setState({ activeWorkspace: "console", fullscreenPaneIdx: 0 });
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
    act(() => { useAppStore.setState({ activeWorkspace: "github" }); });
    rerender();
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(false);
    expect(useAppStore.getState().consoleBroadcast).toBe(false);

    // Back to Console → listener re-attaches → key fires again.
    act(() => { useAppStore.setState({ activeWorkspace: "console" }); });
    rerender();
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(true);
    expect(useAppStore.getState().consoleBroadcast).toBe(true);
  });
});
