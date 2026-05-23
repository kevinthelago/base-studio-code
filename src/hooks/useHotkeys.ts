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
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;

      // F1–F5: navigate screens
      if (SCREEN_KEYS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setScreen(SCREEN_KEYS[e.key]);
        return;
      }

      // Ctrl+1–9: pane focus → fullscreen → restore
      // Use e.code so Ctrl+Shift+1 etc. still resolve to the right digit
      const ctrlDigit = e.ctrlKey && !e.metaKey && !e.altKey && e.code.match(/^Digit([1-9])$/);
      if (ctrlDigit) {
        e.preventDefault();
        const targetIdx = parseInt(ctrlDigit[1], 10) - 1;
        const activeTab = tabs[activeTabIdx];
        const [cols, rows] = activeTab.layout.split("×").map(Number);
        if (targetIdx >= cols * rows) return;

        if (fullscreenPaneIdx === targetIdx) {
          setFullscreenPane(-1);
          setFocusedPane(-1);
        } else if (focusedPaneIdx === targetIdx) {
          setFullscreenPane(targetIdx);
        } else {
          setFullscreenPane(-1);
          setFocusedPane(targetIdx);
        }
        return;
      }

      // Alt+1–5: change focused pane's view (console screen only)
      // Alt+Shift+1–5: change all panes' view (console screen only)
      // Use e.code so Shift doesn't turn "1" into "!" before we read it
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
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeScreen, setScreen,
    tabs, activeTabIdx,
    focusedPaneIdx, fullscreenPaneIdx,
    setFocusedPane, setFullscreenPane,
    setPaneView, setAllPanesView,
  ]);
}
