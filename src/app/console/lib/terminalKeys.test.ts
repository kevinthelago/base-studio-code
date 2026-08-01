// Shift+Enter must reach the PTY as something OTHER than a bare Enter (#4134).
import { describe, it, expect } from "vitest";
import { terminalKeyOverride, SHIFT_ENTER_BYTES, type TerminalKeyEvent } from "./terminalKeys";

const ev = (o: Partial<TerminalKeyEvent> & Pick<TerminalKeyEvent, "key">): TerminalKeyEvent =>
  ({ type: "keydown", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });

describe("terminalKeyOverride", () => {
  it("remaps Shift+Enter to ESC+CR — the sequence Claude Code's own terminal-setup installs", () => {
    expect(terminalKeyOverride(ev({ key: "Enter", shiftKey: true }))).toBe("\x1b\r");
    expect(SHIFT_ENTER_BYTES).toBe("\u001b\r"); // VS Code `"text": "\u001b\r"`, iTerm2 `chars = "\u001B\r"`
  });

  it("is DIFFERENT from a bare Enter — the whole point (xterm sends `\r` for both)", () => {
    expect(terminalKeyOverride(ev({ key: "Enter" }))).toBeNull(); // plain Enter untouched → xterm's `\r`
    expect(SHIFT_ENTER_BYTES).not.toBe("\r");
  });

  it("leaves Ctrl / Alt / Meta + Enter to xterm — only the Shift variant is claimed", () => {
    for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(terminalKeyOverride(ev({ key: "Enter", shiftKey: true, [mod]: true })), mod).toBeNull();
      expect(terminalKeyOverride(ev({ key: "Enter", [mod]: true })), mod).toBeNull();
    }
  });

  it("fires once per press — the keyup half of the same chord is ignored", () => {
    expect(terminalKeyOverride(ev({ key: "Enter", shiftKey: true, type: "keyup" }))).toBeNull();
  });

  it("claims no other key", () => {
    for (const key of ["a", "Tab", "Backspace", "ArrowUp", " ", "Escape"]) {
      expect(terminalKeyOverride(ev({ key, shiftKey: true })), key).toBeNull();
    }
  });
});
