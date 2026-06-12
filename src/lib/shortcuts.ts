// The keyboard-shortcut registry (#487) — the single source of truth for both the
// Settings → Keyboard reference page and the screen-navigation hotkeys in
// useHotkeys. The screen F-keys are defined ONCE here and consumed by both, so the
// reference can't drift from the handler. The remaining chords are documented here
// as the canonical catalog; when adding a hotkey to useHotkeys, add its entry here
// too so the reference stays complete.
//
// Pure data (no React / DOM) so it's unit-testable and importable anywhere.

import type { Screen } from "../components/chrome/Rail";

/** A function-key → screen binding, shown in the catalog and used by useHotkeys. */
export interface ScreenHotkey {
  key: string;
  screen: Screen;
  label: string;
}

/** F1–F6 navigate the rail screens. The one definition both the handler and the
 *  reference derive from. */
export const SCREEN_HOTKEYS: ScreenHotkey[] = [
  { key: "F1", screen: "console",    label: "Console" },
  { key: "F2", screen: "knowledge",  label: "Knowledge" },
  { key: "F3", screen: "automation", label: "Automations" },
  { key: "F4", screen: "github",     label: "GitHub" },
  { key: "F5", screen: "projects",   label: "Projects" },
  { key: "F6", screen: "settings",   label: "Settings" },
];

/** Lookup form for the keydown handler: `e.key` → screen. Derived from
 *  {@link SCREEN_HOTKEYS} so the two can never disagree. */
export const SCREEN_KEY_MAP: Record<string, Screen> =
  Object.fromEntries(SCREEN_HOTKEYS.map((h) => [h.key, h.screen]));

/** One documented shortcut: the key caps of its primary chord + what it does. */
export interface Shortcut {
  /** Key caps, in order (e.g. ["Ctrl", "Shift", "C"]). A range cap like "1–9"
   *  represents a family of digit bindings. */
  keys: string[];
  desc: string;
  /** Where it applies — "Global" or a screen name like "Console". */
  scope: string;
  /** When set, this row is a rebindable single-chord action (#771) — its id ties
   *  it to the handler in useHotkeys and the override stored in the app state, so
   *  the Keyboard page can render its LIVE binding and edit it inline. Items
   *  without an id are fixed (digit families, ranges) and shown read-only. */
  id?: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** The full catalog rendered by the Keyboard settings page, grouped for scanning. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    items: [
      ...SCREEN_HOTKEYS.map((h): Shortcut => ({
        keys: [h.key], desc: `Go to ${h.label}`, scope: "Global",
      })),
      { keys: ["Ctrl", "1–9"], desc: "Switch to workspace tab by number", scope: "Global" },
    ],
  },
  {
    title: "Console · panes",
    items: [
      { id: "fullscreen-toggle", keys: ["Ctrl", "Shift", "F"], desc: "Maximize / restore the focused pane", scope: "Console" },
      { id: "focus-next-waiting", keys: ["Ctrl", "Shift", "N"], desc: "Focus the next pane waiting for input", scope: "Console" },
      { keys: ["Ctrl", "Shift", "1–9"], desc: "Select a pane by number (focus → maximize → restore)", scope: "Console" },
      { keys: ["Alt", "1–5"], desc: "Switch the focused pane's view (console / files / branches / changes / log)", scope: "Console" },
      { keys: ["Alt", "Shift", "1–5"], desc: "Switch every pane's view", scope: "Console" },
    ],
  },
  {
    title: "Console · input & broadcast",
    items: [
      { id: "broadcast-toggle", keys: ["Ctrl", "Shift", "C"], desc: "Toggle broadcast — mirror typing to every pane in the tab", scope: "Console" },
      { id: "clear-input", keys: ["Ctrl", "Shift", "Backspace"], desc: "Clear the focused pane's pending input", scope: "Console" },
      { id: "send-all-enter", keys: ["Alt", "Shift", "Enter"], desc: "Send Enter to every pane in the tab", scope: "Console" },
    ],
  },
  {
    title: "Terminal",
    items: [
      { keys: ["Ctrl", "+"], desc: "Increase terminal font size", scope: "Console" },
      { keys: ["Ctrl", "−"], desc: "Decrease terminal font size", scope: "Console" },
      { keys: ["Ctrl", "0"], desc: "Reset terminal font size", scope: "Console" },
    ],
  },
];
