import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { computeBroadcastTargets } from "@/app/console/lib/broadcast";
import { adjustFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "@/app/console/lib/terminal";
import { nextFullscreen } from "@/app/console/lib/consoleFocus";
import { CLEAR_INPUT_BYTES } from "@/app/console/lib/clearInput";
import { resolvePaneFromBuffer, PANE_SELECT_COMMIT_MS } from "@/app/console/lib/paneSelect";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { paneCountForLayout } from "@/app/console/lib/paneStatus";
import { SCREEN_HOTKEYS } from "@/features/settings";
import { effectiveWorkspace } from "@/app/registry";
import {
  matchesBinding, matchesChord, matchesLeader, eventToLeader, effectiveLeader,
  type RebindableId,
} from "@/features/settings";
import { VIEW_ORDER } from "@/app/console/panes/viewDefs";
import { getPageNav } from "@/shared/ui/layouts/pageNav";
import type { Workspace } from "@/app/chrome/Rail";

/** If `e` matches a screen-navigation F-key (per the active bindings), return the target workspace, else
 *  null. Shared by the always-on global screen-nav listener (every page) and the Console pane-hotkey
 *  effect, so the F-key → screen map lives in exactly one place. */
function screenForEvent(e: KeyboardEvent, bindings: Parameters<typeof matchesBinding>[1]): Workspace | null {
  for (const h of SCREEN_HOTKEYS) {
    if (matchesBinding(e, bindings, `screen-${h.screen}` as RebindableId)) return h.screen;
  }
  return null;
}

/** The next index after stepping `delta` from `from`, wrapping at both ends. Wrapping is what every
 *  tabbed surface does; clamping would make "next" unreachable from the last page without reversing. */
export function stepIndex(from: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (((from + delta) % length) + length) % length;
}

/** Ctrl+← / Ctrl+→ → step the active Workspace's PAGES (#4167). Returns true when it handled the event.
 *
 *  Reads the page model the mounted `Screen` publishes (`shared/` cannot match a keybinding itself —
 *  #1626/#1703 — so it hands over its tabs + selector and the shell does this half). It is a module ref,
 *  not store state (#4170): read at keydown time, it needs no reactivity, and routing it through the
 *  store made an unstable `select` identity into an infinite render loop. No-ops when there is no tabbed
 *  Workspace on screen, or when it holds fewer than two pages. */
function stepPage(e: KeyboardEvent, bindings: Parameters<typeof matchesBinding>[1]): boolean {
  const delta = matchesBinding(e, bindings, "page-next") ? 1
    : matchesBinding(e, bindings, "page-prev") ? -1
    : 0;
  if (delta === 0) return false;
  const nav = getPageNav();
  if (!nav || nav.ids.length < 2) return false;
  const from = nav.ids.indexOf(nav.active);
  // An active id that is not in the visible set (mid-update, or a page just torn off) steps from the
  // front rather than from -1, which would land on the LAST page for a "next".
  const next = nav.ids[stepIndex(from < 0 ? 0 : from, delta, nav.ids.length)];
  if (!next || next === nav.active) return false;
  nav.select(next);
  return true;
}

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

export function useHotkeys() {
  const {
    activeWorkspace,
    setWorkspace,
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
    showConsolePage,
  } = useAppStore();

  // Whether the Console page is actually the live surface. The console-pane hotkeys read the RAW store
  // `activeWorkspace`, but the legacy Console page is opt-in (#2372) and App redirects console→glance
  // when it's off — so without this the hotkeys (broadcast, view-switch, redraw…) would keep firing
  // while Glance is on screen. Gating both effects on the same effective workspace makes the hotkeys
  // follow the toggle, while F-key screen-nav still works on Glance (#3575).
  const onConsole = effectiveWorkspace(activeWorkspace, showConsolePage) === "console";

  // Chained-digit pane selector: digits accumulate while Ctrl+Shift is held,
  // then commit (resolve to a pane) on modifier release or after a short pause.
  const digitBufferRef = useRef("");
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Screen-navigation F-keys switch rail workspaces, so they must fire on EVERY page — NOT just the
  // Console (the pane hotkeys below are Console-only per #1218, which accidentally made F-key nav
  // Console-only too — #2403). This always-on listener handles them OFF the Console page; on the Console
  // page the pane-hotkey effect below handles nav itself (after its broadcast intercept, so an F-key still
  // broadcasts in broadcast mode), so this one is gated off-Console to avoid double-firing.
  useEffect(() => {
    if (onConsole) return;
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      // Don't yank focus away while the user is typing in a field (matches the Console effect's guard).
      // This is ALSO what keeps Ctrl+Arrow word-jump working in every embedded terminal: xterm focuses a
      // `textarea.xterm-helper-textarea`, so the Planner's live session and the studio panes are exempt.
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const bindings = useAppStore.getState().keybindings;
      const navTo = screenForEvent(e, bindings);
      if (navTo) { e.preventDefault(); setWorkspace(navTo); return; }
      // Ctrl+← / Ctrl+→ step the active Workspace's PAGES (#4167) — arrows, not digits, because the
      // console selectors own every digit combination (Ctrl / Ctrl+Shift / Alt / Alt+Shift + a digit).
      // `pageNav` is published by the mounted `Screen`; it is null on a Workspace with no page bar.
      if (stepPage(e, bindings)) e.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onConsole, setWorkspace]);

  useEffect(() => {
    // #1218: the hotkeys are Console-only. Don't attach the document listeners at all unless the
    // Console page is active AND no pane is maximized — so every other screen, and a maximized
    // terminal, gets unobstructed native copy/paste, text selection, and browser shortcuts (the
    // capture-phase listener used to sit in front of all of them). Both gating values are in this
    // effect's dep array, so changing screen or maximizing/restoring re-runs the effect to
    // attach/detach. Exit maximize via the pane header button (the keyboard toggle is off here too).
    if (!onConsole || fullscreenPaneIdx >= 0) return;

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
        e.preventDefault();
        e.stopPropagation();
        setConsoleBroadcast(!consoleBroadcast);
        return;
      }

      // ── Ctrl+Shift+F: maximize / minimize the focused console pane ──────────
      // Before the broadcast intercept so it works in broadcast mode too, and
      // before the inInput guard so it fires while typing in a pane's terminal.
      if (matchesBinding(e, bindings, "fullscreen-toggle")) {
        e.preventDefault();
        e.stopPropagation();
        const next = nextFullscreen(focusedPaneIdx, fullscreenPaneIdx);
        if (next !== null) setFullscreenPane(next);
        return;
      }

      // ── Ctrl+Shift+R: redraw / fix display (#1221) ──────────────────────────
      // Nudge the focused pane's PTY size (a transient SIGWINCH) to force the Claude CLI's TUI to
      // repaint — the in-app equivalent of dragging the window to un-jumble it. Keys off the STABLE
      // pane id (paneIdFor), the same id the terminal watches.
      if (matchesBinding(e, bindings, "redraw-pane")) {
        if (!onConsole) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = fullscreenPaneIdx >= 0 ? fullscreenPaneIdx : focusedPaneIdx;
        if (idx < 0) return;
        const st = useAppStore.getState();
        const tab = st.tabs[activeTabIdx];
        if (tab) st.requestPaneRedraw(paneIdFor(tab, activeTabIdx, idx));
        return;
      }

      // ── Ctrl+Shift+N: focus the next waiting pane (maximize-aware) ──────────
      // Steps through agents that finished a turn. If a pane is maximized it
      // swaps the maximized pane to the next one, so you stay full-screen.
      if (matchesBinding(e, bindings, "focus-next-waiting")) {
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
        e.preventDefault();
        e.stopPropagation();
        if (consoleBroadcast) {
          const activeTab = tabs[activeTabIdx];
          if (!activeTab) return;
          // Key off the tab's STABLE pane ids (paneIdFor) — a manual tab's PTYs are
          // `man:<tabId>:p<n>`, so positional ids would clear nothing (#1176).
          const paneIds = Array.from({ length: paneCountForLayout(activeTab.layout) },
            (_, i) => paneIdFor(activeTab, activeTabIdx, i));
          invoke("pty_broadcast", { paneIds, data: CLEAR_INPUT_BYTES });
        } else if (focusedPaneIdx >= 0) {
          const activeTab = tabs[activeTabIdx];
          if (activeTab) invoke("pty_write", { paneId: paneIdFor(activeTab, activeTabIdx, focusedPaneIdx), data: CLEAR_INPUT_BYTES });
        }
        return;
      }

      // ── Zoom the console terminal font (all panes) ─────────────────────────
      // Before the broadcast intercept so it isn't mirrored as a literal key, and
      // before the inInput guard so it works while typing in a terminal. Rebindable
      // (#773): once a zoom action is overridden it matches its captured chord;
      // otherwise it keeps the default key-based match so BOTH Ctrl++ and Ctrl+=
      // zoom in (the "+" key is Shift+= on most layouts), and numpad +/-/0 fold in
      // via e.key.
      {
        const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
        // Default zoom matches by e.key; an override matches its captured chord.
        const zoom = (id: RebindableId, dflt: boolean): boolean =>
          bindings[id] ? matchesChord(e, bindings[id]) : dflt;
        const zoomReset = zoom("zoom-reset", ctrlOnly && e.key === "0");
        const zoomOut   = zoom("zoom-out",   ctrlOnly && (e.key === "-" || e.key === "_"));
        const zoomIn    = zoom("zoom-in",    ctrlOnly && (e.key === "+" || e.key === "="));
        if (zoomReset || zoomOut || zoomIn) {
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
      if (consoleBroadcast) {
        // Navigation hotkeys (switch tab / pane / view by number) must NOT be
        // broadcast as text — skip them here so they fall through to their handlers
        // below and keep working in broadcast mode (e.g. while driving a fleet).
        const lead = eventToLeader(e);
        const isNavHotkey =
          (/^Digit[0-9]$/.test(e.code) &&
            (lead === effectiveLeader(bindings, "tab-switch") ||
             lead === effectiveLeader(bindings, "pane-select"))) ||
          (/^Digit[1-9]$/.test(e.code) &&
            (lead === effectiveLeader(bindings, "view-switch") ||
             lead === effectiveLeader(bindings, "view-switch-all")));
        const bytes = isNavHotkey ? null : keyToTermBytes(e);
        if (bytes !== null) {
          const activeTab = tabs[activeTabIdx];
          if (activeTab) {
            const { paneIds, suppressDefault } =
              computeBroadcastTargets(activeTab, activeTabIdx, focusedPaneIdx);
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

      // Screen navigation (F-keys, rebindable per screen #773) — handled here too so it works on the
      // Console page. It sits AFTER the broadcast intercept above, so in broadcast mode an F-key is sent
      // to the panes rather than navigating (unchanged). Off-Console, the always-on effect above owns it.
      const navTo = screenForEvent(e, bindings);
      if (navTo) {
        e.preventDefault();
        setWorkspace(navTo);
        return;
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
        e.preventDefault();
        e.stopPropagation();
        const activeTab = tabs[activeTabIdx];
        if (!activeTab) return;
        // Stable pane ids (paneIdFor) so a manual tab's `man:` PTYs are actually hit (#1176).
        const paneIds = Array.from({ length: paneCountForLayout(activeTab.layout) },
          (_, i) => paneIdFor(activeTab, activeTabIdx, i));
        invoke("pty_broadcast", { paneIds, data: "\r" });
        return;
      }

      // Switch pane view by index — Alt+1–5 (focused) / Alt+Shift+1–5 (all) by
      // default; both leaders are rebindable (#773). The all-panes leader is
      // checked first so it wins when it's the more specific combo.
      const viewDigit = e.code.match(/^Digit([1-9])$/);
      if (viewDigit) {
        const allMatch = matchesLeader(e, bindings, "view-switch-all");
        const oneMatch = matchesLeader(e, bindings, "view-switch");
        if (allMatch || oneMatch) {
          // Digits map 1:1 onto VIEW_ORDER (console…telemetry); a digit past the last view is a
          // no-op rather than switching to `undefined`.
          const view = VIEW_ORDER[parseInt(viewDigit[1], 10) - 1];
          if (!view) return;
          e.preventDefault();
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
    onConsole, setWorkspace,
    tabs, activeTabIdx, setActiveTab,
    focusedPaneIdx, fullscreenPaneIdx,
    setFocusedPane, setFullscreenPane,
    setPaneView, setAllPanesView,
    consoleBroadcast, setConsoleBroadcast,
    setTerminalFontSize,
    advanceFocus,
  ]);
}
