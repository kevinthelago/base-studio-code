import { useEffect } from "react";
import { useAppStore } from "../store";
import type { Screen } from "../components/chrome/Rail";
import type { ViewKey } from "../components/pane/ViewTabs";

const SCREEN_KEYS: Record<string, Screen> = {
  F1: "console",
  F2: "knowledge",
  F3: "automation",
  F4: "github",
  F5: "settings",
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
  } = useAppStore();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable;
      // Plain typing in inputs is fine; modifier combos still fire
      if (inInput && !e.ctrlKey && !e.metaKey && !e.altKey) return;

      // F1–F5: navigate screens
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

      // Ctrl+Shift+1–9: select console pane
      //   first press  → focus that pane
      //   second press → fullscreen that pane
      //   third press  → restore
      const ctrlShiftPane = e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code.match(/^Digit([1-9])$/);
      if (ctrlShiftPane) {
        if (activeScreen !== "console") return;
        e.preventDefault();
        const targetIdx = parseInt(ctrlShiftPane[1], 10) - 1;
        const activeTab = tabs[activeTabIdx];
        const [cols, rows] = activeTab.layout.split("×").map(Number);
        if (targetIdx >= cols * rows) return;

        if (fullscreenPaneIdx === targetIdx) {
          // restore from fullscreen
          setFullscreenPane(-1);
          setFocusedPane(-1);
        } else if (focusedPaneIdx === targetIdx) {
          // already focused → fullscreen
          setFullscreenPane(targetIdx);
        } else {
          // focus it
          setFullscreenPane(-1);
          setFocusedPane(targetIdx);
        }
        return;
      }

      // ── ALT = MODIFY ──────────────────────────────────────────────────────

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

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
    focusedPaneIdx, fullscreenPaneIdx,
    setFocusedPane, setFullscreenPane,
    setPaneView, setAllPanesView,
  ]);
}
