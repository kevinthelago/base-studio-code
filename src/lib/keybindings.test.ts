import { describe, it, expect } from "vitest";
import {
  DEFAULT_BINDINGS,
  REBINDABLE_IDS,
  REBINDABLE,
  eventToChord,
  matchesChord,
  matchesBinding,
  effectiveChord,
  chordToCaps,
  findConflict,
  isModifierCode,
  type ChordEvent,
} from "./keybindings";

const ev = (over: Partial<ChordEvent>): ChordEvent => ({
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: "", ...over,
});

describe("eventToChord", () => {
  it("serializes modifiers in a fixed order followed by the code", () => {
    expect(eventToChord(ev({ ctrlKey: true, shiftKey: true, code: "KeyC" }))).toBe("Ctrl+Shift+KeyC");
    // Modifier order is canonical regardless of which is 'set' — Alt before Shift.
    expect(eventToChord(ev({ altKey: true, shiftKey: true, code: "Enter" }))).toBe("Alt+Shift+Enter");
    expect(eventToChord(ev({ ctrlKey: true, shiftKey: true, code: "Backspace" }))).toBe("Ctrl+Shift+Backspace");
    expect(eventToChord(ev({ metaKey: true, code: "KeyK" }))).toBe("Meta+KeyK");
  });

  it("returns null for a bare modifier or empty code (nothing to bind yet)", () => {
    expect(eventToChord(ev({ ctrlKey: true, code: "ControlLeft" }))).toBeNull();
    expect(eventToChord(ev({ shiftKey: true, code: "ShiftRight" }))).toBeNull();
    expect(eventToChord(ev({ code: "" }))).toBeNull();
  });
});

describe("matchesChord / matchesBinding", () => {
  it("matches only an exact modifier set + key", () => {
    const e = ev({ ctrlKey: true, shiftKey: true, code: "KeyC" });
    expect(matchesChord(e, "Ctrl+Shift+KeyC")).toBe(true);
    // A stray Meta breaks the exact match — this is what enforces 'no Meta'.
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, metaKey: true, code: "KeyC" }), "Ctrl+Shift+KeyC")).toBe(false);
    // Wrong key.
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, code: "KeyD" }), "Ctrl+Shift+KeyC")).toBe(false);
  });

  it("matchesBinding honors a custom override, else the default", () => {
    const e = ev({ ctrlKey: true, altKey: true, code: "KeyB" });
    // Default broadcast-toggle is Ctrl+Shift+KeyC, so Ctrl+Alt+B does not match by default…
    expect(matchesBinding(e, {}, "broadcast-toggle")).toBe(false);
    // …but does once overridden.
    expect(matchesBinding(e, { "broadcast-toggle": "Ctrl+Alt+KeyB" }, "broadcast-toggle")).toBe(true);
    // The default still matches when there's no override.
    expect(matchesBinding(ev({ ctrlKey: true, shiftKey: true, code: "KeyC" }), {}, "broadcast-toggle")).toBe(true);
  });
});

describe("effectiveChord", () => {
  it("is the override when present, else the built-in default", () => {
    expect(effectiveChord({}, "fullscreen-toggle")).toBe(DEFAULT_BINDINGS["fullscreen-toggle"]);
    expect(effectiveChord({ "fullscreen-toggle": "Alt+KeyF" }, "fullscreen-toggle")).toBe("Alt+KeyF");
  });
});

describe("chordToCaps", () => {
  it("turns code tokens into readable key caps", () => {
    expect(chordToCaps("Ctrl+Shift+KeyC")).toEqual(["Ctrl", "Shift", "C"]);
    expect(chordToCaps("Ctrl+Shift+Backspace")).toEqual(["Ctrl", "Shift", "Backspace"]);
    expect(chordToCaps("Alt+Shift+Enter")).toEqual(["Alt", "Shift", "Enter"]);
    expect(chordToCaps("Ctrl+Digit1")).toEqual(["Ctrl", "1"]);
  });
});

describe("findConflict", () => {
  it("flags another rebindable action that already uses the chord", () => {
    // fullscreen-toggle's default is Ctrl+Shift+KeyF; binding focus-next-waiting to it conflicts.
    expect(findConflict({}, "focus-next-waiting", "Ctrl+Shift+KeyF")).toBe("fullscreen-toggle");
    // No conflict for an unused chord.
    expect(findConflict({}, "focus-next-waiting", "Ctrl+Shift+KeyZ")).toBeNull();
    // Re-assigning an action to its own current chord is not a conflict.
    expect(findConflict({}, "fullscreen-toggle", "Ctrl+Shift+KeyF")).toBeNull();
    // Conflicts respect overrides, not just defaults.
    expect(findConflict({ "clear-input": "Ctrl+Alt+KeyX" }, "broadcast-toggle", "Ctrl+Alt+KeyX")).toBe("clear-input");
  });
});

describe("isModifierCode", () => {
  it("identifies the bare modifier keys", () => {
    for (const c of ["ControlLeft", "ControlRight", "AltLeft", "ShiftLeft", "MetaRight"]) {
      expect(isModifierCode(c)).toBe(true);
    }
    expect(isModifierCode("KeyC")).toBe(false);
    expect(isModifierCode("Enter")).toBe(false);
  });
});

describe("registry wiring", () => {
  it("has a default chord for every rebindable id", () => {
    for (const id of REBINDABLE_IDS) {
      expect(DEFAULT_BINDINGS[id]).toBeTruthy();
    }
  });

  it("REBINDABLE carries a human label per id (no drift from the catalog)", () => {
    expect(REBINDABLE.map((r) => r.id)).toEqual([...REBINDABLE_IDS]);
    for (const r of REBINDABLE) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.label).not.toBe(r.id); // resolved from SHORTCUT_GROUPS desc, not the raw id
    }
  });

  it("screen-nav and zoom are rebindable single chords (#773)", () => {
    expect(DEFAULT_BINDINGS["screen-console"]).toBe("F1");
    expect(DEFAULT_BINDINGS["screen-settings"]).toBe("F6");
    expect(DEFAULT_BINDINGS["zoom-in"]).toBe("Ctrl+Equal");
    expect(DEFAULT_BINDINGS["zoom-reset"]).toBe("Ctrl+Digit0");
    // A bare F-key serializes to just the code, with no modifiers.
    expect(eventToChord(ev({ code: "F1" }))).toBe("F1");
    expect(matchesBinding(ev({ code: "F1" }), {}, "screen-console")).toBe(true);
    // Conflict detection spans the whole rebindable set, screen + console actions included.
    expect(findConflict({}, "screen-knowledge", "F1")).toBe("screen-console");
  });

  it("chordToCaps labels the zoom symbol codes", () => {
    expect(chordToCaps("Ctrl+Equal")).toEqual(["Ctrl", "="]);
    expect(chordToCaps("Ctrl+Minus")).toEqual(["Ctrl", "−"]);
  });
});
