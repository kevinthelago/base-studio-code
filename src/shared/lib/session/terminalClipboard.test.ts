// Terminal clipboard (#3157) — copy-on-select + paste wiring.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachTerminalClipboard } from "./terminalClipboard";

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
