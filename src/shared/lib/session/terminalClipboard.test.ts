/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
// Terminal clipboard (#3157) — copy-on-select + paste wiring.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachTerminalClipboard } from "@/shared/lib/session/terminalClipboard";
import { invoke } from "@tauri-apps/api/core";

// A minimal xterm-Terminal stand-in: a real DOM element for the mouse listeners + a captured custom key
// handler so we can fire keydowns at it and read its verdict.
function fakeTerm(selection = "") {
  const element = document.createElement("div");
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  const term = {
    element,
    getSelection: () => selection,
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { keyHandler = h; },
  } as unknown as Terminal;
  return { term, element, fireKey: (e: KeyboardEvent) => keyHandler!(e) };
}

const clip = { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve("pasted")) };

beforeEach(() => {
  clip.writeText.mockClear();
  clip.readText.mockClear();
  vi.mocked(invoke).mockClear();
  Object.defineProperty(globalThis.navigator, "clipboard", { value: clip, configurable: true });
});

describe("attachTerminalClipboard (#3157)", () => {
  it("copy-on-select: a mouse-up with a selection writes it to the clipboard", () => {
    const { term, element } = fakeTerm("hello world");
    attachTerminalClipboard(term, "pane1");
    element.dispatchEvent(new MouseEvent("mouseup"));
    expect(clip.writeText).toHaveBeenCalledWith("hello world");
  });

  it("never clobbers the clipboard on a mouse-up with no selection", () => {
    const { term, element } = fakeTerm("");
    attachTerminalClipboard(term, "pane1");
    element.dispatchEvent(new MouseEvent("mouseup"));
    expect(clip.writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+V pastes (reads clipboard) and swallows the key (returns false)", () => {
    const { term, fireKey } = fakeTerm();
    attachTerminalClipboard(term, "pane1");
    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(false);
    expect(clip.readText).toHaveBeenCalledTimes(1);
  });

  it("Shift+Insert pastes", () => {
    const { term, fireKey } = fakeTerm();
    attachTerminalClipboard(term, "pane1");
    expect(fireKey(new KeyboardEvent("keydown", { shiftKey: true, key: "Insert" }))).toBe(false);
    expect(clip.readText).toHaveBeenCalledTimes(1);
  });

  it("passes other keys through (Ctrl+C stays SIGINT, plain typing untouched)", () => {
    const { term, fireKey } = fakeTerm();
    attachTerminalClipboard(term, "pane1");
    expect(fireKey(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, key: "c" }))).toBe(true); // ^C → SIGINT, not copy
    expect(fireKey(new KeyboardEvent("keyup", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(true); // only keydown acts
    expect(clip.readText).not.toHaveBeenCalled();
  });

  it("right-click pastes; the disposer removes the mouse listeners", () => {
    const { term, element } = fakeTerm("sel");
    const dispose = attachTerminalClipboard(term, "pane1");
    element.dispatchEvent(new MouseEvent("contextmenu"));
    expect(clip.readText).toHaveBeenCalledTimes(1);
    dispose();
    element.dispatchEvent(new MouseEvent("mouseup"));     // listener gone → no copy
    element.dispatchEvent(new MouseEvent("contextmenu")); // listener gone → no extra paste
    expect(clip.writeText).not.toHaveBeenCalled();
    expect(clip.readText).toHaveBeenCalledTimes(1);
  });
});

/**
 * #one-terminal-one-key-handler — the two bugs behind "the listeners are eating my paste".
 *
 * xterm's `attachCustomKeyEventHandler` is an ASSIGNMENT: one handler per terminal, last call wins. Two
 * callers used to attach one to the same terminal (TerminalView's Shift+Enter, this module's paste), so
 * the later one silently replaced the earlier. Every terminal mock in the suite stubs that setter as a
 * bare `vi.fn()`, and a spy cannot observe last-wins — which is why it shipped green. `fakeTerm` above
 * models the real semantics, so these tests can see it.
 */
describe("one terminal, one key handler", () => {
  it("composes the injected override with the paste chords — BOTH survive one attach", () => {
    const { term, fireKey } = fakeTerm();
    const keyOverride = vi.fn((e: { key: string; shiftKey: boolean }) =>
      e.key === "Enter" && e.shiftKey ? "\x1b\r" : null);
    attachTerminalClipboard(term, "pane1", { keyOverride });

    // The override's key is claimed and its bytes are sent...
    expect(fireKey(new KeyboardEvent("keydown", { shiftKey: true, key: "Enter" }))).toBe(false);
    expect(invoke).toHaveBeenCalledWith("pty_write", { paneId: "pane1", data: "\x1b\r" });
    // ...and the paste chord still works through the same single handler.
    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(false);
    expect(clip.readText).toHaveBeenCalledTimes(1);
    // A key neither of them claims is untouched.
    expect(fireKey(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  });

  it("attaches EXACTLY ONE handler, so nothing it composes can be clobbered", () => {
    const element = document.createElement("div");
    let attaches = 0;
    const term = {
      element,
      getSelection: () => "",
      attachCustomKeyEventHandler: () => { attaches += 1; },
    } as unknown as Terminal;
    attachTerminalClipboard(term, "pane1", { keyOverride: () => null });
    expect(attaches).toBe(1);
  });

  it("does NOT swallow a paste chord when the clipboard read is unavailable", () => {
    // WebKitGTK (the webview on Linux) refuses readText. Claiming the key and then doing nothing is what
    // "my paste disappears" is: the chord must fall through so the native path still has a chance.
    Object.defineProperty(globalThis.navigator, "clipboard", { value: {}, configurable: true });
    const { term, fireKey } = fakeTerm();
    attachTerminalClipboard(term, "pane1");
    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(true);
    expect(fireKey(new KeyboardEvent("keydown", { shiftKey: true, key: "Insert" }))).toBe(true);
  });

  it("stops swallowing once a read REJECTS, and leaves the native context menu alone", async () => {
    // The refusal arrives after the key was already claimed, so the first chord is spent learning it.
    const denied = { readText: vi.fn(() => Promise.reject(new Error("NotAllowedError"))), writeText: vi.fn() };
    Object.defineProperty(globalThis.navigator, "clipboard", { value: denied, configurable: true });
    const { term, element, fireKey } = fakeTerm();
    attachTerminalClipboard(term, "pane1");

    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(false);
    await vi.waitFor(() => expect(denied.readText).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // let the REJECTION land, not just the call

    // From here the chord falls through, and the context menu is no longer suppressed — its own Paste
    // item is native, so it still works where this cannot.
    expect(fireKey(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "V" }))).toBe(true);
    const menu = new MouseEvent("contextmenu", { cancelable: true });
    element.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(denied.readText).toHaveBeenCalledTimes(1); // never retried
  });

  it("a copy with no writeText does not throw", () => {
    Object.defineProperty(globalThis.navigator, "clipboard", { value: {}, configurable: true });
    const { term, element } = fakeTerm("hello");
    attachTerminalClipboard(term, "pane1");
    expect(() => element.dispatchEvent(new MouseEvent("mouseup"))).not.toThrow();
  });
});
