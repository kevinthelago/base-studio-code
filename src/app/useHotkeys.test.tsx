import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useHotkeys, stepIndex } from "./useHotkeys";
import { useAppStore } from "@/store";
import { setPageNav } from "@/shared/ui/layouts/pageNav";

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
  // The page model is a module ref (#4170), not store state — reset it so it cannot leak between tests.
  setPageNav(null);
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

  it("F1 navigates to Glance — the key the retired console page freed up (#4167)", () => {
    // F1 was Console until #2403 retired that page, and then belonged to nothing. Glance meanwhile had NO
    // key at all despite being where the app lands (`effectiveWorkspace` sends console → glance while the
    // Console page is off), so the default screen was the one screen you could not reach by keyboard.
    useAppStore.setState({ activeWorkspace: "settings" });
    renderHook(() => useHotkeys());

    const ev = pressKey({ code: "F1" });

    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    expect(ev.defaultPrevented).toBe(true);
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

// ── Ctrl+← / Ctrl+→ page navigation (#4167) ────────────────────────────────────────────────────────
//
// PageTabs — the strip every Workspace shows — had NO keyboard navigation at all. The binding is arrows
// rather than digits because the console selectors already own every digit combination (Ctrl /
// Ctrl+Shift / Alt / Alt+Shift + a digit), so a digit family could not avoid colliding with one.
//
// The MATCHING lives here rather than in `Screen` because `shared/` may not import value symbols from
// features/app (#1626/#1703); Screen publishes `pageNav` and the shell steps it.
describe("useHotkeys — Ctrl+arrow page navigation (#4167)", () => {
  const PAGES = ["library", "runs", "logs"];

  function withPages(active: string, select = vi.fn()) {
    // Off the Console page: that is where the always-on listener (which owns page nav) attaches, and
    // the Console workspace has no PageTabs at all.
    useAppStore.setState({ activeWorkspace: "settings" });
    setPageNav({ ids: PAGES, active, select });
    renderHook(() => useHotkeys());
    return select;
  }

  it("steps to the next and previous page", () => {
    const select = withPages("runs");
    const next = pressKey({ code: "ArrowRight", ctrlKey: true });
    expect(select).toHaveBeenCalledWith("logs");
    expect(next.defaultPrevented).toBe(true);

    select.mockClear();
    pressKey({ code: "ArrowLeft", ctrlKey: true });
    expect(select).toHaveBeenCalledWith("library");
  });

  it("wraps at both ends rather than stopping", () => {
    const last = withPages("logs");
    pressKey({ code: "ArrowRight", ctrlKey: true });
    expect(last).toHaveBeenCalledWith("library");
    cleanup();

    const first = withPages("library");
    pressKey({ code: "ArrowLeft", ctrlKey: true });
    expect(first).toHaveBeenCalledWith("logs");
  });

  it("does nothing when no tabbed workspace is on screen, or it holds one page", () => {
    const select = vi.fn();
    useAppStore.setState({ activeWorkspace: "settings" });
    setPageNav(null);
    renderHook(() => useHotkeys());
    const ev = pressKey({ code: "ArrowRight", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    cleanup();

    // A single page has nowhere to step — it must not preventDefault either.
    setPageNav({ ids: ["only"], active: "only", select });
    renderHook(() => useHotkeys());
    expect(pressKey({ code: "ArrowRight", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("does not fire while typing — which is also what keeps embedded TERMINALS working", () => {
    // xterm focuses a `textarea.xterm-helper-textarea`, so this one guard preserves Ctrl+Arrow
    // word-jump in the Planner's live session and every studio pane.
    const select = withPages("runs");
    for (const tag of ["textarea", "input"] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
      });
      el.remove();
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("requires an EXACT Ctrl — Shift/Alt/Meta variants stay free for other bindings", () => {
    const select = withPages("runs");
    pressKey({ code: "ArrowRight", ctrlKey: true, shiftKey: true });
    pressKey({ code: "ArrowRight", ctrlKey: true, altKey: true });
    pressKey({ code: "ArrowRight", ctrlKey: true, metaKey: true });
    pressKey({ code: "ArrowRight" });
    expect(select).not.toHaveBeenCalled();
  });

  it("follows a REBOUND chord", () => {
    // Rebindable like the other single-chord actions, so the handler must read the LIVE override.
    useAppStore.setState({ keybindings: { "page-next": "Alt+ArrowDown" } });
    const select = withPages("runs");
    pressKey({ code: "ArrowRight", ctrlKey: true });     // the default chord no longer matches
    expect(select).not.toHaveBeenCalled();
    pressKey({ code: "ArrowDown", altKey: true });        // the override does
    expect(select).toHaveBeenCalledWith("logs");
  });

  it("stepIndex wraps in both directions", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);   // no pages ⇒ no target
  });
});

