// Rebindable keyboard shortcuts (#771, follow-up to #487).
//
// A "chord" is a normalized string: the active modifiers in a fixed order
// followed by the main key's `KeyboardEvent.code`, joined with "+", e.g.
// "Ctrl+Shift+KeyC", "Alt+Shift+Enter", "Ctrl+Shift+Backspace". Using `code`
// (physical key) rather than `key` keeps a binding stable across Shift/locale,
// matching how useHotkeys already discriminates (`e.code === "KeyC"`).
//
// Only the single-chord console actions are rebindable; the digit-family / range
// bindings (screen F-keys, Ctrl+1–9, Alt+1–5, zoom, …) are parameterized by a
// digit, not a single chord, so they stay fixed. Pure data + functions (no React
// / DOM types beyond the structural event shape) so this is unit-testable.

import { SHORTCUT_GROUPS } from "./shortcuts";

/** The shortcut ids that can be rebound (single modifier+key chords). */
export const REBINDABLE_IDS = [
  "broadcast-toggle",
  "fullscreen-toggle",
  "focus-next-waiting",
  "clear-input",
  "send-all-enter",
] as const;

export type RebindableId = (typeof REBINDABLE_IDS)[number];

/** Built-in chord for each rebindable action — the value useHotkeys matched
 *  before rebinding existed. The user's overrides fall back to these. */
export const DEFAULT_BINDINGS: Record<RebindableId, string> = {
  "broadcast-toggle":   "Ctrl+Shift+KeyC",
  "fullscreen-toggle":  "Ctrl+Shift+KeyF",
  "focus-next-waiting": "Ctrl+Shift+KeyN",
  "clear-input":        "Ctrl+Shift+Backspace",
  "send-all-enter":     "Alt+Shift+Enter",
};

/** The structural subset of KeyboardEvent the chord helpers read — lets the
 *  pure functions be called with a plain object in tests. */
export interface ChordEvent {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}

/** `code` values that are themselves modifier keys — a chord can't be just a
 *  modifier, so capture ignores these until a real key arrives. */
export function isModifierCode(code: string): boolean {
  return (
    code === "ControlLeft" || code === "ControlRight" ||
    code === "AltLeft"     || code === "AltRight" ||
    code === "ShiftLeft"   || code === "ShiftRight" ||
    code === "MetaLeft"    || code === "MetaRight"
  );
}

/** Serialize an event to its chord string, or `null` when the main key is a bare
 *  modifier (nothing to bind yet). */
export function eventToChord(e: ChordEvent): string | null {
  if (!e.code || isModifierCode(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.altKey)   parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  parts.push(e.code);
  return parts.join("+");
}

/** Whether an event exactly matches a chord string (exact modifier set + key).
 *  Exact match is what enforces "no Meta, no Alt" etc. for the default chords. */
export function matchesChord(e: ChordEvent, chord: string): boolean {
  return eventToChord(e) === chord;
}

/** The active chord for an id: the user's override, else the built-in default. */
export function effectiveChord(
  bindings: Record<string, string>,
  id: RebindableId,
): string {
  return bindings[id] ?? DEFAULT_BINDINGS[id];
}

/** Whether an event matches the active binding for a rebindable id. */
export function matchesBinding(
  e: ChordEvent,
  bindings: Record<string, string>,
  id: RebindableId,
): boolean {
  return matchesChord(e, effectiveChord(bindings, id));
}

const CODE_LABELS: Record<string, string> = {
  Backspace: "Backspace",
  Enter: "Enter",
  Space: "Space",
  Escape: "Esc",
  Tab: "Tab",
  Delete: "Del",
};

/** A single `code` token → its key cap label (e.g. "KeyC" → "C", "Digit1" → "1",
 *  "Backspace" → "Backspace"). Modifier tokens pass through unchanged. */
function codeToCap(token: string): string {
  if (token.startsWith("Key")) return token.slice(3);
  if (token.startsWith("Digit")) return token.slice(5);
  if (token.startsWith("Numpad")) return token.slice(6);
  if (token.startsWith("Arrow")) return token.slice(5);
  return CODE_LABELS[token] ?? token;
}

/** Split a chord string into display key caps, e.g. "Ctrl+Shift+KeyC" →
 *  ["Ctrl", "Shift", "C"]. */
export function chordToCaps(chord: string): string[] {
  return chord.split("+").map(codeToCap);
}

/** The rebindable id (other than `self`) whose active binding equals `chord`,
 *  or `null` when there's no conflict. Lets the UI block a duplicate. */
export function findConflict(
  bindings: Record<string, string>,
  self: RebindableId,
  chord: string,
): RebindableId | null {
  for (const id of REBINDABLE_IDS) {
    if (id === self) continue;
    if (effectiveChord(bindings, id) === chord) return id;
  }
  return null;
}

/** Metadata for the rebindable shortcuts, sourced from SHORTCUT_GROUPS (a leaf
 *  module — no import cycle with useHotkeys) so the labels can't drift from the
 *  reference rows the same ids tag. */
export interface RebindableMeta {
  id: RebindableId;
  label: string;
}

const SHORTCUT_BY_ID: Record<string, string> = Object.fromEntries(
  SHORTCUT_GROUPS.flatMap((g) => g.items)
    .filter((s) => s.id != null)
    .map((s) => [s.id as string, s.desc]),
);

export const REBINDABLE: RebindableMeta[] = REBINDABLE_IDS.map((id) => ({
  id,
  label: SHORTCUT_BY_ID[id] ?? id,
}));
