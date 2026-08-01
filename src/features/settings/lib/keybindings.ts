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

/** The shortcut ids that can be rebound (single modifier+key chords). Screen
 *  navigation (single F-keys) and terminal zoom (single Ctrl chords) are single
 *  chords too, so they use this same mechanism. The digit-RANGE bindings
 *  (Ctrl+1–9 etc.) are a separate "leader" model — see LEADER_IDS below.
 *
 *  A `screen-*` id MUST be `screen-${Workspace}` for a workspace in SCREEN_HOTKEYS:
 *  `useHotkeys` looks its binding up by that derived key, so a Workspace rename that
 *  misses this list silently kills the F-key (#2702 renamed `agents` → `security` and
 *  left `screen-agents` here, so F7 matched nothing at all). The
 *  `screen-nav ids track SCREEN_HOTKEYS` test pins the two together. */
export const REBINDABLE_IDS = [
  "broadcast-toggle",
  "fullscreen-toggle",
  "focus-next-waiting",
  "clear-input",
  "redraw-pane",
  "send-all-enter",
  "page-prev",
  "page-next",
  "screen-glance",
  "screen-projects",
  "screen-skills",
  "screen-automation",
  "screen-mcp",
  "screen-github",
  "screen-security",
  "screen-settings",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
] as const;

export type RebindableId = (typeof REBINDABLE_IDS)[number];

/** Built-in chord for each rebindable action — the value useHotkeys matched
 *  before rebinding existed. The user's overrides fall back to these.
 *
 *  Zoom defaults are the canonical `code` chords (used for conflict detection +
 *  the captured-override display); useHotkeys still matches the *unbound* zoom
 *  keys by `e.key` so `Ctrl++` and `Ctrl+=` both zoom in as before. */
export const DEFAULT_BINDINGS: Record<RebindableId, string> = {
  "broadcast-toggle":   "Ctrl+Shift+KeyC",
  "fullscreen-toggle":  "Ctrl+Shift+KeyF",
  "focus-next-waiting": "Ctrl+Shift+KeyN",
  "clear-input":        "Ctrl+Shift+Backspace",
  "redraw-pane":        "Ctrl+Shift+KeyR",
  "send-all-enter":     "Alt+Shift+Enter",
  // #4167 — PAGE navigation. Arrows, not digits: every digit combination is already a console selector
  // leader (Ctrl / Ctrl+Shift / Alt / Alt+Shift), so a digit family here could not avoid a collision.
  "page-prev":          "Ctrl+ArrowLeft",
  "page-next":          "Ctrl+ArrowRight",
  "screen-glance":      "F1",
  "screen-projects":    "F2",
  "screen-skills":      "F3",
  "screen-automation":  "F4",
  "screen-mcp":         "F5",
  "screen-github":      "F6",
  "screen-security":    "F7",
  "screen-settings":    "F8",
  "zoom-in":            "Ctrl+Equal",
  "zoom-out":           "Ctrl+Minus",
  "zoom-reset":         "Ctrl+Digit0",
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
  Equal: "=",
  Minus: "−",
};

const ARROW_CAPS: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};

/** A single `code` token → its key cap label (e.g. "KeyC" → "C", "Digit1" → "1",
 *  "Backspace" → "Backspace"). Modifier tokens pass through unchanged. */
function codeToCap(token: string): string {
  if (token.startsWith("Key")) return token.slice(3);
  if (token.startsWith("Digit")) return token.slice(5);
  if (token.startsWith("Numpad")) return token.slice(6);
  // Arrows render as their GLYPH (#4167) — "Ctrl ←" reads as a key cap where "Ctrl Left" reads as prose.
  if (token.startsWith("Arrow")) return ARROW_CAPS[token] ?? token.slice(5);
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

// ── Leader bindings (#773, Tier 2) ──────────────────────────────────────────
//
// The digit-RANGE shortcuts (Ctrl+1–9 tab switch, Ctrl+Shift+1–9 pane select,
// Alt+1–5 view, Alt+Shift+1–5 view-all) aren't single chords — they're a
// modifier "leader" + ANY digit. You rebind the leader (e.g. tab-switch Ctrl →
// Alt), not one key. A leader is the same modifier-order serialization as a
// chord, but with no main key (e.g. "Ctrl", "Ctrl+Shift").

export const LEADER_IDS = [
  "tab-switch",
  "pane-select",
  "view-switch",
  "view-switch-all",
] as const;

export type LeaderId = (typeof LEADER_IDS)[number];

export const DEFAULT_LEADERS: Record<LeaderId, string> = {
  "tab-switch":      "Ctrl",
  "pane-select":     "Ctrl+Shift",
  "view-switch":     "Alt",
  "view-switch-all": "Alt+Shift",
};

/** The modifier combos offered in the leader dropdown. */
export const LEADER_OPTIONS = [
  "Ctrl",
  "Alt",
  "Shift",
  "Ctrl+Shift",
  "Ctrl+Alt",
  "Alt+Shift",
  "Ctrl+Alt+Shift",
] as const;

/** The active modifiers of an event, in canonical order, with no main key —
 *  e.g. Ctrl+Shift+Digit1 → "Ctrl+Shift". "" when no modifier is held. */
export function eventToLeader(e: ChordEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.altKey)   parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  return parts.join("+");
}

/** The active leader for an id: the user's override, else the built-in default. */
export function effectiveLeader(bindings: Record<string, string>, id: LeaderId): string {
  return bindings[id] ?? DEFAULT_LEADERS[id];
}

/** Whether an event's modifiers exactly equal the active leader for an id. */
export function matchesLeader(e: ChordEvent, bindings: Record<string, string>, id: LeaderId): boolean {
  return eventToLeader(e) === effectiveLeader(bindings, id);
}

/** Another leader id (other than `self`) whose active leader equals `leader`. */
export function findLeaderConflict(
  bindings: Record<string, string>,
  self: LeaderId,
  leader: string,
): LeaderId | null {
  for (const id of LEADER_IDS) {
    if (id === self) continue;
    if (effectiveLeader(bindings, id) === leader) return id;
  }
  return null;
}

/** Leader string → modifier caps (e.g. "Ctrl+Shift" → ["Ctrl", "Shift"]). */
export function leaderToCaps(leader: string): string[] {
  return leader === "" ? [] : leader.split("+");
}

const LEADER_LABEL_BY_ID: Record<string, string> = SHORTCUT_BY_ID;
export const LEADER_META: { id: LeaderId; label: string }[] = LEADER_IDS.map((id) => ({
  id,
  label: LEADER_LABEL_BY_ID[id] ?? id,
}));
