import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalView } from "./TerminalView";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";

/**
 * #1239: the native console-input overlay (#1158) is reverted for Claude CLI sessions, so Claude's
 * own TUI input shows instead. These tests pin the three behaviors that change:
 *   1. no ConsoleInput overlay is rendered even while a Claude session is active;
 *   2. the terminal host is normal height (100%) — the grow-taller-than-the-clip-box hack is gone;
 *   3. focus lands on the terminal while a Claude session is active (keystrokes reach Claude).
 */

// xterm can't initialize in jsdom (open() needs real DOM measurements), so stub the Terminal +
// FitAddon with spies. focusSpy is hoisted so the mock factory can close over it.
const { focusSpy } = vi.hoisted(() => ({ focusSpy: vi.fn() }));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    parser = { registerOscHandler: vi.fn() };
    loadAddon = vi.fn();
    // #3992: `open()` is when xterm measures real cell metrics, so the mock models that — before it
    // runs, `cols`/`rows` are the 80x24 DEFAULTS. `pty_create` is called with those fields, so this is
    // what lets a test tell "sized" from "not yet sized".
    open = vi.fn(() => { this.cols = 120; this.rows = 40; });
    write = vi.fn();
    scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = focusSpy;
    dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
  }
  return { FitAddon };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const PANE = "t0p0";

beforeAll(() => {
  // jsdom reports 0 for layout — give every element real dimensions so openIfReady() opens the
  // terminal (openedRef becomes true), which the focus effect requires.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  // Run rAF callbacks synchronously so the focus effect's deferred focus() fires within render.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

beforeEach(() => {
  focusSpy.mockClear();
  // Simulate a live Claude session in this pane (what the OSC-100 "run" signal sets).
  useAppStore.setState({ paneClaudeActive: { [PANE]: true } });
});

afterEach(() => cleanup());

describe("TerminalView — Claude CLI native input reverted (#1239)", () => {
  it("renders no ConsoleInput overlay while a Claude session is active", () => {
    const { container } = render(<TerminalView paneId={PANE} visible focused />);
    // The overlay was the only textarea TerminalView rendered; with it gone there is none.
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[placeholder*="Message the agent"]')).toBeNull();
  });

  it("keeps the terminal host at 100% height (no CLIP_ROWS grow hack)", () => {
    const { container } = render(<TerminalView paneId={PANE} visible focused />);
    const heights = Array.from(container.querySelectorAll<HTMLElement>("div")).map((d) => d.style.height);
    // The clip-box hack used a calc(100% + …px) host height; it must be gone.
    expect(heights.some((h) => h.includes("calc"))).toBe(false);
    // And the terminal host is a plain 100%.
    expect(heights).toContain("100%");
  });

  it("focuses the terminal while a Claude session is active", async () => {
    // #3975: `term.open()` now waits for an admission slot (one frame), so focus lands a frame later
    // than it used to. `openIfReady` focuses on open when this pane wants focus, so the ordering is
    // handled whichever way the race falls — but the assertion has to await the frame.
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
  });
});

describe("PTY geometry (#3992)", () => {
  it("passes the terminal's measured size to pty_create, not the raw defaults", () => {
    // NOT a regression guard, and I checked rather than assuming: this test still passes when the
    // broken #3975 ordering is restored, because jsdom has no layout — `openIfReady`'s
    // `offsetWidth === 0` branch and the frame ordering it gates are both unobservable here. The
    // decisive check for #3992 is the runtime log line `pty[…] created · <cols>x<rows>`: 80x24 there
    // means the invoke beat the fit. Kept because it does pin the contract that `pty_create` reads
    // the terminal's dimensions rather than hardcoding any, which is the thing that made the
    // ordering matter in the first place.
    render(<TerminalView paneId={PANE} visible focused />);
    return waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "pty_create");
      expect(call, "pty_create was invoked").toBeTruthy();
      const args = call![1] as { cols: number; rows: number };
      expect({ cols: args.cols, rows: args.rows }).toEqual({ cols: 120, rows: 40 });
    });
  });
});
