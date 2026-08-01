// The keyboard-shortcut registry (#487) — the single source of truth for both the
// Settings → Keyboard reference page and the screen-navigation hotkeys in
// useHotkeys. The screen F-keys are defined ONCE here and consumed by both, so the
// reference can't drift from the handler. The remaining chords are documented here
// as the canonical catalog; when adding a hotkey to useHotkeys, add its entry here
// too so the reference stays complete.
//
// Pure data (no React / DOM) so it's unit-testable and importable anywhere.

import type { Workspace } from "@/app/chrome/Rail";

/** A function-key → screen binding, shown in the catalog and used by useHotkeys. */
export interface ScreenHotkey {
  key: string;
  screen: Workspace;
  label: string;
}

/** F1–F8 navigate the rail screens. The one definition both the handler and the reference derive from.
 *  (F1 was Console until the console page's retirement, #2372/#2403; #4167 gave it to **Glance**, which
 *  had no key at all even though it is where the app LANDS — `effectiveWorkspace` redirects
 *  `console → glance` while the Console page is off, so you could key away from the default screen and
 *  never key back.) */
export const SCREEN_HOTKEYS: ScreenHotkey[] = [
  { key: "F1", screen: "glance",     label: "Glance" },
  { key: "F2", screen: "projects",   label: "Planner" },
  { key: "F3", screen: "skills",     label: "Skills" },
  { key: "F4", screen: "automation", label: "Automations" },
  { key: "F5", screen: "mcp",        label: "MCP" },
  { key: "F6", screen: "github",     label: "GitHub" },
  { key: "F7", screen: "security",     label: "Security" },
  { key: "F8", screen: "settings",   label: "Settings" },
];

/** Lookup form for the keydown handler: `e.key` → screen. Derived from
 *  {@link SCREEN_HOTKEYS} so the two can never disagree. */
export const SCREEN_KEY_MAP: Record<string, Workspace> =
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
        id: `screen-${h.screen}`, keys: [h.key], desc: `Go to ${h.label}`, scope: "Global",
      })),
      // #4167 — the PAGE strip every Workspace shows (Screen + PageTabs). Deliberately arrows, not
      // digits: the console selectors own the whole digit space across four leaders (Ctrl / Ctrl+Shift /
      // Alt / Alt+Shift + a digit), so any digit family here would collide with one of them.
      { id: "page-prev", keys: ["Ctrl", "←"], desc: "Previous page in this workspace", scope: "Global" },
      { id: "page-next", keys: ["Ctrl", "→"], desc: "Next page in this workspace", scope: "Global" },
      { id: "tab-switch", keys: ["Ctrl", "1–9"], desc: "Switch to console tab by number", scope: "Console" },
    ],
  },
  {
    title: "Console · panes",
    items: [
      { id: "fullscreen-toggle", keys: ["Ctrl", "Shift", "F"], desc: "Maximize / restore the focused pane", scope: "Console" },
      { id: "focus-next-waiting", keys: ["Ctrl", "Shift", "N"], desc: "Focus the next pane waiting for input", scope: "Console" },
      { id: "pane-select", keys: ["Ctrl", "Shift", "1–9"], desc: "Select a pane by number (focus → maximize → restore)", scope: "Console" },
      { id: "view-switch", keys: ["Alt", "1–7"], desc: "Switch the focused pane's view (console / files / branches / changes / log / tools / telemetry)", scope: "Console" },
      { id: "view-switch-all", keys: ["Alt", "Shift", "1–7"], desc: "Switch every pane in the tab to that view", scope: "Console" },
    ],
  },
  {
    title: "Console · input & broadcast",
    items: [
      { id: "broadcast-toggle", keys: ["Ctrl", "Shift", "C"], desc: "Toggle broadcast — mirror typing to every pane in the tab", scope: "Console" },
      { id: "clear-input", keys: ["Ctrl", "Shift", "Backspace"], desc: "Clear the focused pane's pending input", scope: "Console" },
      { id: "redraw-pane", keys: ["Ctrl", "Shift", "R"], desc: "Redraw / fix display — repaint a jumbled Claude CLI", scope: "Console" },
      { id: "send-all-enter", keys: ["Alt", "Shift", "Enter"], desc: "Send Enter to every pane in the tab", scope: "Console" },
    ],
  },
  {
    title: "Terminal",
    items: [
      { id: "zoom-in", keys: ["Ctrl", "+"], desc: "Increase terminal font size", scope: "Console" },
      { id: "zoom-out", keys: ["Ctrl", "−"], desc: "Decrease terminal font size", scope: "Console" },
      { id: "zoom-reset", keys: ["Ctrl", "0"], desc: "Reset terminal font size", scope: "Console" },
    ],
  },
];

/** A single keyboard shortcut, flattened for integrity checks + display. */
export interface ShortcutDef {
  id: string;
  label: string;
  keys: string;
  description: string;
  /** Workspace context where the shortcut is active; undefined means global. */
  context?: string;
}

/** Single source of truth for every keyboard shortcut in the app. The Keyboard settings page
 *  derives its reference list from this registry; the `useHotkeys` handler (app shell) consumes it. */
export const SHORTCUT_REGISTRY: ShortcutDef[] = [
  { id: "screen-automation",   label: "Go to Automations",        keys: "F3",                  description: "Switch to the Automations screen" },
  { id: "screen-github",       label: "Go to GitHub",             keys: "F4",                  description: "Switch to the GitHub screen" },
  { id: "screen-projects",     label: "Go to Projects",           keys: "F5",                  description: "Switch to the Projects screen" },
  { id: "screen-settings",     label: "Go to Settings",           keys: "F6",                  description: "Switch to the Settings screen" },
  { id: "tab-switch",          label: "Switch tab",               keys: "Ctrl+1–9",            description: "Jump to workspace tab by index" },
  { id: "broadcast-toggle",    label: "Toggle broadcast",         keys: "Ctrl+Shift+C",        description: "Mirror keystrokes to every console in the active tab", context: "Console" },
  { id: "fullscreen-toggle",   label: "Fullscreen pane",          keys: "Ctrl+Shift+F",        description: "Maximize or restore the focused console pane",         context: "Console" },
  { id: "focus-next-waiting",  label: "Next waiting pane",        keys: "Ctrl+Shift+N",        description: "Cycle focus to the next agent waiting for a reply",    context: "Console" },
  { id: "clear-input",         label: "Clear pane input",         keys: "Ctrl+Shift+Backspace", description: "Send Ctrl+U to kill the current input line",           context: "Console" },
  { id: "redraw-pane",         label: "Redraw / fix display",     keys: "Ctrl+Shift+R",        description: "Repaint the focused console pane — un-jumble the Claude CLI's TUI", context: "Console" },
  { id: "pane-select",         label: "Select pane",              keys: "Ctrl+Shift+1–9",      description: "Focus or fullscreen a console pane by number",         context: "Console" },
  { id: "zoom-in",             label: "Zoom terminal in",         keys: "Ctrl++",              description: "Increase terminal font size",                          context: "Console" },
  { id: "zoom-out",            label: "Zoom terminal out",        keys: "Ctrl+−",              description: "Decrease terminal font size",                          context: "Console" },
  { id: "zoom-reset",          label: "Reset terminal zoom",      keys: "Ctrl+0",              description: "Reset terminal font size to the default",              context: "Console" },
  { id: "send-all-enter",      label: "Broadcast Enter",          keys: "Alt+Shift+Enter",     description: "Send Enter to every pane in the active tab",           context: "Console" },
  { id: "view-switch",         label: "Switch pane view",         keys: "Alt+1–7",             description: "Switch focused pane's view (console/files/branches/changes/log/tools/telemetry)", context: "Console" },
  { id: "view-switch-all",     label: "Switch all pane views",    keys: "Alt+Shift+1–7",       description: "Switch every pane in the tab to that view at once",    context: "Console" },
];
