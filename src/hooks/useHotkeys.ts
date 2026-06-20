import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { computeBroadcastTargets } from "../lib/console/broadcast";
import { adjustFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/console/terminal";
import { nextFullscreen } from "../lib/console/consoleFocus";
import { CLEAR_INPUT_BYTES } from "../lib/console/clearInput";
import { resolvePaneFromBuffer, PANE_SELECT_COMMIT_MS } from "../lib/console/paneSelect";
import { SCREEN_HOTKEYS } from "../lib/settings/shortcuts";
import {
  matchesBinding, matchesChord, matchesLeader, eventToLeader, effectiveLeader,
  type RebindableId,
} from "../lib/settings/keybindings";
import type { ViewKey } from "../components/pane/ViewTabs";

export interface ShortcutDef {
  id: string;
  label: string;
  keys: string;
  description: string;
  /** Screen context where the shortcut is active; undefined means global. */
  context?: string;
}

/** Single source of truth for every keyboard shortcut in the app.
 *  The Keyboard settings page derives its reference list from this registry. */
export const SHORTCUT_REGISTRY: ShortcutDef[] = [
  { id: "screen-console",      label: "Go to Console",            keys: "F1",                  description: "Switch to the Console screen" },
  { id: "screen-automation",   label: "Go to Automations",        keys: "F3",                  description: "Switch to the Automations screen" },
  { id: "screen-github",       label: "Go to GitHub",             keys: "F4",                  description: "Switch to the GitHub screen" },
  { id: "screen-projects",     label: "Go to Projects",           keys: "F5",                  description: "Switch to the Projects screen" },
  { id: "screen-settings",     label: "Go to Settings",           keys: "F6",                  description: "Switch to the Settings screen" },
  { id: "tab-switch",          label: "Switch tab",               keys: "Ctrl+1–9",            description: "Jump to workspace tab by index" },
  { id: "broadcast-toggle",    label: "Toggle broadcast",         keys: "Ctrl+Shift+C",        description: "Mirror keystrokes to every console in the active tab", context: "Console" },
  { id: "fullscreen-toggle",   label: "Fullscreen pane",          keys: "Ctrl+Shift+F",        description: "Maximize or restore the focused console pane",         context: "Console" },
  { id: "focus-next-waiting",  label: "Next waiting pane",        keys: "Ctrl+Shift+N",        description: "Cycle focus to the next agent waiting for a reply",    context: "Console" },
  { id: "clear-input",         label: "Clear pane input",         keys: "Ctrl+Shift+Backspace", description: "Send Ctrl+U to kill the current input line",           context: "Console" },
  { id: "pane-select",         label: "Select pane",              keys: "Ctrl+Shift+1–9",      description: "Focus or fullscreen a console pane by number",         context: "Console" },
  { id: "zoom-in",             label: "Zoom terminal in",         keys: "Ctrl++",              description: "Increase terminal font size",                          context: "Console" },
  { id: "zoom-out",            label: "Zoom terminal out",        keys: "Ctrl+−",              description: "Decrease terminal font size",                          context: "Console" },
  { id: "zoom-reset",          label: "Reset terminal zoom",      keys: "Ctrl+0",              description: "Reset terminal font size to the default",              context: "Console" },
  { id: "send-all-enter",      label: "Broadcast Enter",          keys: "Alt+Shift+Enter",     description: "Send Enter to every pane in the active tab",           context: "Console" },
  { id: "view-switch",         label: "Switch pane view",         keys: "Alt+1–5",             description: "Switch focused pane's view (console/files/branches/changes/log)", context: "Console" },
  { id: "view-switch-all",     label: "Switch all pane views",    keys: "Alt+Shift+1–5",       description: "Switch every pane's view at once",                     context: "Console" },
];

function keyToTermBytes(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, shiftKey } = e;

  // Bare modifier keys — nothing to send
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock",
       "ScrollLock", "Pause", "ContextMenu", "Dead"].includes(key)) return null;

  // Ctrl+letter → ASCII control codes (skip Shift variants — those are separate hotkeys)
  if (ctrlKey && !altKey && !shiftKey && key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  }
  if (ctrlKey && !altKey && !shiftKey && key === " ") return "\x00";

  const esc = altKey ? "\x1b" : "";

  switch (key) {
    case "Enter":      return esc + "\r";
    case "Backspace":  return esc + "\x7f";
    case "Tab":        return shiftKey ? "\x1b[Z" : esc + "\t";
    case "Escape":     return "\x1b";
    case "Delete":     return esc + "\x1b[3~";
    case "ArrowUp":    return esc + "\x1b[A";
    case "ArrowDown":  return esc + "\x1b[B";
    case "ArrowRight": return esc + "\x1b[C";
    case "ArrowLeft":  return esc + "\x1b[D";
    case "Home":       return esc + "\x1b[H";
    case "End":        return esc + "\x1b[F";
    case "PageUp":     return esc + "\x1b[5~";
    case "PageDown":   return esc + "\x1b[6~";
    case "F1":  return "\x1bOP";  case "F2":  return "\x1bOQ";
    case "F3":  return "\x1bOR";  case "F4":  return "\x1bOS";
    case "F5":  return "\x1b[15~"; case "F6": return "\x1b[17~";
    case "F7":  return "\x1b[18~"; case "F8": return "\x1b[19~";
    case "F9":  return "\x1b[20~"; case "F10":return "\x1b[21~";
    case "F11": return "\x1b[23~"; case "F12":return "\x1b[24~";
  }

  // Printable single character (shift already reflected in e.key value)
  if (key.length === 1) return esc + key;

  return null;
}

const VIEWS_ORDER: ViewKey[] = ["console", "files", "branches", "changes", "log"];

export function useHotkeys() {
  const {
    activeScreen,
    setScreen,
    tabs,
    activeTabIdx,
    setActiveTab,
    focusedPaneIdx,
    fullscreenPaneIdx,
    setFocusedPane,
    setFullscreenPane,
    setPaneView,
    setAllPanesView,
    consoleBroadcast,
    setConsoleBroadcast,
    setTerminalFontSize,
    advanceFocus,
  } = useAppStore();

  // Chained-digit pane selector: digits accumulate while Ctrl+Shift is held,
  // then commit (resolve to a pane) on modifier release or after a short pause.
  const digitBufferRef = useRef("");
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Resolve the accumulated pane-number buffer and run the focus → fullscreen →
    // restore cycle on it. State is read fresh (the timer fires later) so a stale
    // closure can't mis-target.
    function commitDigitBuffer() {
      if (commitTimerRef.current) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
      const buf = digitBufferRef.current;
      digitBufferRef.current = "";
      if (!buf) return;
      const { tabs, activeTabIdx, focusedPaneIdx, fullscreenPaneIdx } = useAppStore.getState();
      const activeTab = tabs[activeTabIdx];
      if (!activeTab) return;
      const [cols, rows] = activeTab.layout.split("×").map(Number);
      const idx = resolvePaneFromBuffer(buf, cols * rows);
      if (idx === null) return;
      if (fullscreenPaneIdx === idx) {
        setFullscreenPane(-1);
        setFocusedPane(-1);
      } else if (focusedPaneIdx === idx) {
        setFullscreenPane(idx);
      } else {
        setFullscreenPane(-1);
        setFocusedPane(idx);
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable;

      // Active custom keybindings (#771) — read fresh so a rebind takes effect
      // without re-subscribing the listener. Each rebindable action matches its
      // chord by id (custom override ?? built-in default).
      const bindings = useAppStore.getState().keybindings;

      // ── Ctrl+Shift+C: toggle broadcast mode ───────────────────────────────
      // Must come before the broadcast intercept and the inInput guard.
      if (matchesBinding(e, bindings, "broadcast-toggle")) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        setConsoleBroadcast(!consoleBroadcast);
        return;
      }

      // ── Ctrl+Shift+F: maximize / minimize the focused console pane ──────────
      // Before the broadcast intercept so it works in broadcast mode too, and
      // before the inInput guard so it fires while typing in a pane's terminal.
      if (matchesBinding(e, bindings, "fullscreen-toggle")) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        const next = nextFullscreen(focusedPaneIdx, fullscreenPaneIdx);
        if (next !== null) setFullscreenPane(next);
        return;
      }

      // ── Ctrl+Shift+N: focus the next waiting pane (maximize-aware) ──────────
      // Steps through agents that finished a turn. If a pane is maximized it
      // swaps the maximized pane to the next one, so you stay full-screen.
      if (matchesBinding(e, bindings, "focus-next-waiting")) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        advanceFocus();
        return;
      }

      // ── Ctrl+Shift+Backspace: clear the focused pane's pending input ────────
      // Sends Ctrl+U to the PTY — kills cursor-to-start in bash readline (the
      // whole line when the cursor's at the end, the common case) and clears
      // claude's TUI input box. In broadcast mode mirrors to every pane on
      // the active tab — including the focused one, since we send the bytes
      // directly rather than via xterm.onData, so there's no double-write to
      // worry about (#192).
      if (matchesBinding(e, bindings, "clear-input")) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        if (consoleBroadcast) {
          const activeTab = tabs[activeTabIdx];
          if (!activeTab) return;
          const [c, r] = activeTab.layout.split("×").map(Number);
          const paneIds = Array.from({ length: (c || 1) * (r || 1) }, (_, i) => `t${activeTabIdx}p${i}`);
          invoke("pty_broadcast", { paneIds, data: CLEAR_INPUT_BYTES });
        } else if (focusedPaneIdx >= 0) {
          invoke("pty_write", { paneId: `t${activeTabIdx}p${focusedPaneIdx}`, data: CLEAR_INPUT_BYTES });
        }
        return;
      }

      // ── Zoom the console terminal font (global, all panes) ─────────────────
      // Before the broadcast intercept so it isn't mirrored as a literal key, and
      // before the inInput guard so it works while typing in a terminal. Rebindable
      // (#773): once a zoom action is overridden it matches its captured chord;
      // otherwise it keeps the default key-based match so BOTH Ctrl++ and Ctrl+=
      // zoom in (the "+" key is Shift+= on most layouts), and numpad +/-/0 fold in
      // via e.key. Off the console screen we let the browser have the event.
      {
        const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
        // Default zoom matches by e.key; an override matches its captured chord.
        const zoom = (id: RebindableId, dflt: boolean): boolean =>
          bindings[id] ? matchesChord(e, bindings[id]) : dflt;
        const zoomReset = zoom("zoom-reset", ctrlOnly && e.key === "0");
        const zoomOut   = zoom("zoom-out",   ctrlOnly && (e.key === "-" || e.key === "_"));
        const zoomIn    = zoom("zoom-in",    ctrlOnly && (e.key === "+" || e.key === "="));
        if (zoomReset || zoomOut || zoomIn) {
          if (activeScreen !== "console") return;
          e.preventDefault();
          e.stopPropagation();
          const cur = useAppStore.getState().terminalFontSize;
          if (zoomReset)     setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
          else if (zoomOut)  setTerminalFontSize(adjustFontSize(cur, -1));
          else               setTerminalFontSize(adjustFontSize(cur, +1));
          return;
        }
      }

      // ── Broadcast intercept ────────────────────────────────────────────────
      // In broadcast mode keystrokes mirror to every console in the ACTIVE tab.
      // The focused pane handles its own keystroke through xterm — including it
      // in pty_broadcast would double-write and drop the first letter — so it is
      // excluded. computeBroadcastTargets reconstructs pane ids strictly from the
      // active tab, and only excludes a focus index that is actually within this
      // tab (a stale index from another tab must not skip one of these consoles).
      if (consoleBroadcast && activeScreen === "console") {
        // Navigation hotkeys (switch tab / pane / view by number) must NOT be
        // broadcast as text — skip them here so they fall through to their handlers
        // below and keep working in broadcast mode (e.g. while driving a fleet).
        const lead = eventToLeader(e);
        const isNavHotkey =
          (/^Digit[0-9]$/.test(e.code) &&
            (lead === effectiveLeader(bindings, "tab-switch") ||
             lead === effectiveLeader(bindings, "pane-select"))) ||
          (/^Digit[1-5]$/.test(e.code) &&
            (lead === effectiveLeader(bindings, "view-switch") ||
             lead === effectiveLeader(bindings, "view-switch-all")));
        const bytes = isNavHotkey ? null : keyToTermBytes(e);
        if (bytes !== null) {
          const activeTab = tabs[activeTabIdx];
          if (activeTab) {
            const [cols, rows] = activeTab.layout.split("×").map(Number);
            const { paneIds, suppressDefault } =
              computeBroadcastTargets(activeTabIdx, cols * rows, focusedPaneIdx);
            if (paneIds.length > 0) {
              invoke("pty_broadcast", { paneIds, data: bytes });
            }
            if (suppressDefault) {
              e.preventDefault();
              e.stopPropagation();
            }
          }
          return;
        }
      }

      // Plain typing in inputs is fine; modifier combos still fire
      if (inInput && !e.ctrlKey && !e.metaKey && !e.altKey) return;

      // Screen navigation (F1–F6 by default, rebindable per screen #773).
      for (const h of SCREEN_HOTKEYS) {
        if (matchesBinding(e, bindings, `screen-${h.screen}` as RebindableId)) {
          e.preventDefault();
          setScreen(h.screen);
          return;
        }
      }

      // ── CTRL = SELECT ─────────────────────────────────────────────────────

      // Tab switch by index — Ctrl+1–9 by default; the leader is rebindable (#773).
      const tabDigit = e.code.match(/^Digit([1-9])$/);
      if (tabDigit && matchesLeader(e, bindings, "tab-switch")) {
        e.preventDefault();
        const targetIdx = parseInt(tabDigit[1], 10) - 1;
        if (targetIdx < tabs.length) setActiveTab(targetIdx);
        return;
      }

      // Ctrl+Shift+<digits>: select a console pane by number.
      //   Hold Ctrl+Shift and type one or more digits — they accumulate so panes
      //   10+ are reachable (e.g. 1 then 3 → pane 13). The number commits on a
      //   short pause or when Ctrl/Shift is released (see onKeyUp), so a single
      //   digit still feels instant. On the resolved pane the selection cycles
      //   focus → fullscreen → restore, exactly as a direct press did before.
      const paneDigit = e.code.match(/^Digit(\d)$/);
      if (paneDigit && matchesLeader(e, bindings, "pane-select")) {
        if (activeScreen !== "console") return;
        e.stopPropagation();
        e.preventDefault();
        digitBufferRef.current += paneDigit[1];
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        commitTimerRef.current = setTimeout(commitDigitBuffer, PANE_SELECT_COMMIT_MS);
        return;
      }

      // ── ALT = MODIFY ──────────────────────────────────────────────────────

      // Alt+Shift+Enter: broadcast Enter to every pane (one-shot, regardless of broadcast mode)
      if (matchesBinding(e, bindings, "send-all-enter")) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        const activeTab = tabs[activeTabIdx];
        if (!activeTab) return;
        const [cols, rows] = activeTab.layout.split("×").map(Number);
        const paneIds: string[] = [];
        for (let i = 0; i < cols * rows; i++) paneIds.push(`t${activeTabIdx}p${i}`);
        invoke("pty_broadcast", { paneIds, data: "\r" });
        return;
      }

      // Switch pane view by index — Alt+1–5 (focused) / Alt+Shift+1–5 (all) by
      // default; both leaders are rebindable (#773). The all-panes leader is
      // checked first so it wins when it's the more specific combo.
      const viewDigit = e.code.match(/^Digit([1-5])$/);
      if (viewDigit) {
        const allMatch = matchesLeader(e, bindings, "view-switch-all");
        const oneMatch = matchesLeader(e, bindings, "view-switch");
        if (allMatch || oneMatch) {
          if (activeScreen !== "console") return;
          e.preventDefault();
          const view = VIEWS_ORDER[parseInt(viewDigit[1], 10) - 1];
          if (allMatch) {
            setAllPanesView(view);
          } else if (focusedPaneIdx >= 0) {
            setPaneView(focusedPaneIdx, view);
          }
          return;
        }
      }
    }

    // Releasing any modifier commits a pending pane-number buffer immediately, so
    // single-digit selections don't wait out the timeout — regardless of which
    // modifier leader pane-select is bound to (#773).
    function onKeyUp(e: KeyboardEvent) {
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key) && digitBufferRef.current) {
        commitDigitBuffer();
      }
    }

    // Capture phase: fires before element handlers (including xterm's textarea listener),
    // so pane/tab hotkeys are intercepted regardless of which element has focus.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      if (commitTimerRef.current) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    };
  }, [
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
    focusedPaneIdx, fullscreenPaneIdx,
    setFocusedPane, setFullscreenPane,
    setPaneView, setAllPanesView,
    consoleBroadcast, setConsoleBroadcast,
    setTerminalFontSize,
    advanceFocus,
  ]);
}
