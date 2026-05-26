import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { computeBroadcastTargets } from "../lib/broadcast";
import { adjustFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/terminal";
import { nextFullscreen } from "../lib/consoleFocus";
import { resolvePaneFromBuffer, PANE_SELECT_COMMIT_MS } from "../lib/paneSelect";
import type { Screen } from "../components/chrome/Rail";
import type { ViewKey } from "../components/pane/ViewTabs";

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

const SCREEN_KEYS: Record<string, Screen> = {
  F1: "console",
  F2: "knowledge",
  F3: "automation",
  F4: "github",
  F5: "projects",
  F6: "settings",
};

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

      // ── Ctrl+Shift+C: toggle broadcast mode ───────────────────────────────
      // Must come before the broadcast intercept and the inInput guard.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code === "KeyC") {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        setConsoleBroadcast(!consoleBroadcast);
        return;
      }

      // ── Ctrl+Shift+F: maximize / minimize the focused console pane ──────────
      // Before the broadcast intercept so it works in broadcast mode too, and
      // before the inInput guard so it fires while typing in a pane's terminal.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code === "KeyF") {
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
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code === "KeyN") {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        advanceFocus();
        return;
      }

      // ── Ctrl +/- /0: zoom the console terminal font (global, all panes) ─────
      // Before the broadcast intercept so it isn't mirrored as a literal key, and
      // before the inInput guard so it works while typing in a terminal. "+"/"="
      // zoom in, "-"/"_" out, "0" resets; Shift state and numpad keys are folded
      // in via e.key. Off the console screen we let the browser have the event.
      if (e.ctrlKey && !e.metaKey && !e.altKey &&
          ["+", "=", "-", "_", "0"].includes(e.key)) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        e.stopPropagation();
        const cur = useAppStore.getState().terminalFontSize;
        if (e.key === "0")                      setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
        else if (e.key === "-" || e.key === "_") setTerminalFontSize(adjustFontSize(cur, -1));
        else                                     setTerminalFontSize(adjustFontSize(cur, +1));
        return;
      }

      // ── Broadcast intercept ────────────────────────────────────────────────
      // In broadcast mode keystrokes mirror to every console in the ACTIVE tab.
      // The focused pane handles its own keystroke through xterm — including it
      // in pty_broadcast would double-write and drop the first letter — so it is
      // excluded. computeBroadcastTargets reconstructs pane ids strictly from the
      // active tab, and only excludes a focus index that is actually within this
      // tab (a stale index from another tab must not skip one of these consoles).
      if (consoleBroadcast && activeScreen === "console") {
        const bytes = keyToTermBytes(e);
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

      // F1–F6: navigate screens
      if (SCREEN_KEYS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setScreen(SCREEN_KEYS[e.key]);
        return;
      }

      // ── CTRL = SELECT ─────────────────────────────────────────────────────

      // Ctrl+1–9: switch to workspace tab by index
      const ctrlTab = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code.match(/^Digit([1-9])$/);
      if (ctrlTab) {
        e.preventDefault();
        const targetIdx = parseInt(ctrlTab[1], 10) - 1;
        if (targetIdx < tabs.length) setActiveTab(targetIdx);
        return;
      }

      // Ctrl+Shift+<digits>: select a console pane by number.
      //   Hold Ctrl+Shift and type one or more digits — they accumulate so panes
      //   10+ are reachable (e.g. 1 then 3 → pane 13). The number commits on a
      //   short pause or when Ctrl/Shift is released (see onKeyUp), so a single
      //   digit still feels instant. On the resolved pane the selection cycles
      //   focus → fullscreen → restore, exactly as a direct press did before.
      const ctrlShiftDigit = e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code.match(/^Digit(\d)$/);
      if (ctrlShiftDigit) {
        if (activeScreen !== "console") return;
        e.stopPropagation();
        e.preventDefault();
        digitBufferRef.current += ctrlShiftDigit[1];
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        commitTimerRef.current = setTimeout(commitDigitBuffer, PANE_SELECT_COMMIT_MS);
        return;
      }

      // ── ALT = MODIFY ──────────────────────────────────────────────────────

      // Alt+Shift+Enter: broadcast Enter to every pane (one-shot, regardless of broadcast mode)
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.shiftKey && e.key === "Enter") {
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

      // Alt+1–5: switch focused pane's view
      // Alt+Shift+1–5: switch ALL panes' view
      const altDigit = e.altKey && !e.ctrlKey && !e.metaKey && e.code.match(/^Digit([1-5])$/);
      if (altDigit) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        const view = VIEWS_ORDER[parseInt(altDigit[1], 10) - 1];
        if (e.shiftKey) {
          setAllPanesView(view);
        } else if (focusedPaneIdx >= 0) {
          setPaneView(focusedPaneIdx, view);
        }
        return;
      }
    }

    // Releasing Ctrl/Shift commits a pending pane-number buffer immediately, so
    // single-digit selections don't wait out the timeout.
    function onKeyUp(e: KeyboardEvent) {
      if ((e.key === "Control" || e.key === "Shift") && digitBufferRef.current) {
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
