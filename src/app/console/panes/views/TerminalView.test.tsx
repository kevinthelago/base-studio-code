import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalView } from "@/app/console/panes/views/TerminalView";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SHIFT_ENTER_BYTES } from "@/app/console/lib/terminalKeys";

/**
 * #1239: the native console-input overlay (#1158) is reverted for Claude CLI sessions, so Claude's
 * own TUI input shows instead. These tests pin the three behaviors that change:
 *   1. no ConsoleInput overlay is rendered even while a Claude session is active;
 *   2. the terminal host is normal height (100%) — the grow-taller-than-the-clip-box hack is gone;
 *   3. focus lands on the terminal while a Claude session is active (keystrokes reach Claude).
 */

// xterm can't initialize in jsdom (open() needs real DOM measurements), so stub the Terminal +
// FitAddon with spies. focusSpy is hoisted so the mock factory can close over it.
// `fits`/`refreshes` are the #3996 debounce probes — every FitAddon/Terminal the component builds
// registers its spies here, so a test can count how many fits a burst of resize callbacks produced.
const { focusSpy, fits, refreshes, keyHandlers, writes } = vi.hoisted(() => ({
  focusSpy: vi.fn(),
  fits: [] as ReturnType<typeof vi.fn>[],
  refreshes: [] as ReturnType<typeof vi.fn>[],
  // #one-terminal-one-key-handler: xterm's setter is an ASSIGNMENT — one handler per terminal, last call
  // wins. Stubbing it as a bare `vi.fn()` (what this mock did, and what `src/test/setup.ts` still does for
  // terminals nobody drives) makes a clobber invisible, which is how a second attach silently killed
  // Shift+Enter. Capturing every handler is what lets a test see how many there are and drive the real one.
  keyHandlers: [] as Array<(e: KeyboardEvent) => boolean>,
  // Every Terminal the component builds registers its write spy here, so a test can read what
  // actually reached the terminal (the exit banner, #a-dead-console-pane-still-looks-alive).
  writes: [] as ReturnType<typeof vi.fn>[],
}));

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
    attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => { keyHandlers.push(h); });
    getSelection = vi.fn(() => "");
    refresh = vi.fn();
    constructor() { refreshes.push(this.refresh); writes.push(this.write); }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
    constructor() { fits.push(this.fit); }
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
  keyHandlers.length = 0;
  writes.length = 0;
  // `listen` calls accumulate across tests; without this the exit handler found belongs to an
  // already-unmounted terminal from an earlier test, and the banner lands on a spy nobody reads.
  vi.mocked(listen).mockClear();
  vi.mocked(invoke).mockClear();   // same reason — call ORDER is only comparable within one test
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

describe("resize coalescing (#3996)", () => {
  // A grid relayout, a dock grow, or a divider drag walks the container through many intermediate
  // sizes. Fitting on EVERY callback let a terminal settle on a size measured mid-flight — and if the
  // last transient happened to equal the final box, the observer never fired again to correct it,
  // which is the "too many rows for the pane" symptom. `useScreenSession` (the planner path) already
  // coalesced to the settled size; this pins the same behaviour for the console.
  //
  // Unlike the #3992 test above, this one IS a real regression guard — debouncing is pure timer logic,
  // so jsdom's missing layout does not blind it.
  let fire: (() => void) | undefined;

  beforeEach(() => {
    fire = undefined;
    fits.length = 0;
    refreshes.length = 0;
    vi.useFakeTimers();
    // Capturing stub — the file-wide one in beforeAll never invokes its callback.
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) { fire = () => this.cb(); }
      observe() {}
      unobserve() {}
      disconnect() { fire = undefined; }
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("fits once for a burst of resize callbacks, not once per callback", () => {
    render(<TerminalView paneId={PANE} visible focused />);
    const fit = fits[fits.length - 1];
    expect(fire, "the component observed its container").toBeTruthy();

    // Warm-up. Under fake timers the admission-gated open (#3992) has not resolved yet, so THIS
    // settled callback is the one that opens the terminal — and `open()` fits once on its own,
    // independently of the observer. Spend that here so the burst below counts only refits.
    fire!();
    vi.advanceTimersByTime(90);

    fit.mockClear();
    for (let i = 0; i < 5; i++) fire!();
    expect(fit, "no fit until the burst settles").not.toHaveBeenCalled();
    vi.advanceTimersByTime(90);
    expect(fit, "five callbacks cost one settled fit").toHaveBeenCalledTimes(1);

    // #2837: the buffer is repainted at the size it actually ended up.
    expect(refreshes[refreshes.length - 1]).toHaveBeenCalled();
  });

  it("drops a pending refit when the pane unmounts", () => {
    const { unmount } = render(<TerminalView paneId={PANE} visible focused />);
    const fit = fits[fits.length - 1];
    fire!();
    vi.advanceTimersByTime(90); // warm-up (see above)
    fit.mockClear();
    fire!();
    unmount();
    vi.advanceTimersByTime(90);
    // Firing against a disposed terminal is what threw the uncaught #2832 error.
    expect(fit, "no fit after dispose").not.toHaveBeenCalled();
  });
});

/**
 * #one-terminal-one-key-handler — the app-level half of the fix.
 *
 * `TerminalView` used to attach its own Shift+Enter handler (#4134) at construction, and
 * `attachTerminalClipboard` attached the paste chords (#3157) later from `openIfReady`. Since xterm keeps
 * exactly ONE custom key handler, the clipboard attach replaced the override and Shift+Enter stopped
 * working in every terminal in the app. The override now travels INTO the clipboard attach, so there is a
 * single handler and both behaviors live in it.
 */
describe("one terminal, one key handler", () => {
  it("attaches exactly one custom key handler", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(keyHandlers.length).toBeGreaterThan(0));
    expect(keyHandlers, "a second attach would silently replace the first").toHaveLength(1);
  });

  it("Shift+Enter still sends ESC+CR through that one handler", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(keyHandlers).toHaveLength(1));
    vi.mocked(invoke).mockClear();

    const claimed = keyHandlers[0](new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(claimed, "the chord is claimed so xterm does not ALSO send a plain CR").toBe(false);
    expect(invoke).toHaveBeenCalledWith("pty_write", { paneId: PANE, data: SHIFT_ENTER_BYTES });
  });

  it("a plain Enter is left to xterm", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(keyHandlers).toHaveLength(1));
    vi.mocked(invoke).mockClear();
    expect(keyHandlers[0](new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    const writes = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "pty_write");
    expect(writes, "a submit must go through xterm's own CR, not ours").toHaveLength(0);
  });
});

/**
 * #a-dead-console-pane-still-looks-alive — a pane must SAY when its session is gone.
 *
 * TerminalView subscribed to `pty_data_<pane>` but never `pty_exit_<pane>`, so a console pane could not
 * learn that its shell had exited. The terminal kept its last frame, the cursor kept blinking, and
 * `pty_write` for a vanished session returns Ok and drops the bytes — so every keystroke after the exit
 * silently succeeded into nothing. Reported as terminals freezing with no way to reproduce, which is
 * exactly what it is: not a state you enter, one you are left in.
 */
describe("a dead console pane says so", () => {
  const exitHandler = () => {
    const call = vi.mocked(listen).mock.calls.find(([evt]) => evt === `pty_exit_${PANE}`);
    return call?.[1] as ((ev: unknown) => void) | undefined;
  };

  it("subscribes to its pane's pty_exit", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(exitHandler()).toBeTypeOf("function"));
  });

  it("writes a visible banner into the terminal when the session ends", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(exitHandler()).toBeTypeOf("function"));
    const write = writes[writes.length - 1];
    write.mockClear();

    exitHandler()!({ payload: undefined });

    const written = write.mock.calls.map((c) => String(c[0])).join("");
    expect(written, "an exited pane must not look like an idle prompt").toContain("session ended");
    expect(written, "and it must say how to get a live shell back").toMatch(/relaunch/i);
  });

  it("subscribes BEFORE the PTY is spawned, so an immediate exit is not missed", async () => {
    render(<TerminalView paneId={PANE} visible focused />);
    await waitFor(() => expect(exitHandler()).toBeTypeOf("function"));
    const subscribed = vi.mocked(listen).mock.invocationCallOrder[
      vi.mocked(listen).mock.calls.findIndex(([evt]) => evt === `pty_exit_${PANE}`)
    ];
    const created = vi.mocked(invoke).mock.invocationCallOrder[
      vi.mocked(invoke).mock.calls.findIndex(([cmd]) => cmd === "pty_create")
    ];
    expect(created, "pty_create should have been called").toBeDefined();
    expect(subscribed).toBeLessThan(created);
  });
});
