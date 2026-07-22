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
    // The console-pane hotkeys only fire when the (opt-in, #2372) Console page is enabled — the default
    // suite scenario is "console is the live surface", so turn it on. The #3575 block below covers off.
    showConsolePage: true,
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

describe("useHotkeys — console hotkeys follow the Console-page toggle (#3575)", () => {
  it("does NOT fire the console hotkeys when the page is off, even if the workspace is stale-console", () => {
    // A persisted (or just-toggled-off) `activeWorkspace: "console"` renders Glance (App redirects), so
    // the console hotkeys must stay inert — this is the leak the gating closes.
    useAppStore.setState({ activeWorkspace: "console", showConsolePage: false });
    renderHook(() => useHotkeys());

    const ev = pressKey(BROADCAST_TOGGLE);

    expect(useAppStore.getState().consoleBroadcast).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("still navigates screens via F-keys while the console page is off (redirect → Glance)", () => {
    // The console-effect is detached, so the always-on nav listener (gated on the EFFECTIVE workspace)
    // must own F-keys on the redirected Glance surface — otherwise screen nav would go dead.
    useAppStore.setState({ activeWorkspace: "console", showConsolePage: false });
    renderHook(() => useHotkeys());

    const ev = pressKey({ code: "F6" }); // screen-github

    expect(useAppStore.getState().activeWorkspace).toBe("github");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("resumes firing the console hotkeys when the page toggle flips on", () => {
    useAppStore.setState({ activeWorkspace: "console", showConsolePage: false });
    const { rerender } = renderHook(() => useHotkeys());
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(false); // off → inert

    act(() => { useAppStore.setState({ showConsolePage: true }); });
    rerender();
    expect(pressKey(BROADCAST_TOGGLE).defaultPrevented).toBe(true);  // on → fires
    expect(useAppStore.getState().consoleBroadcast).toBe(true);
  });
});
