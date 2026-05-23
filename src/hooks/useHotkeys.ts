import { useEffect } from "react";
import { useAppStore } from "../store";
import type { Screen } from "../components/chrome/Rail";

const SCREEN_KEYS: Record<string, Screen> = {
  F1: "console",
  F2: "knowledge",
  F3: "automation",
  F4: "github",
  F5: "settings",
};

export function useHotkeys() {
  const {
    setScreen,
    tabs,
    activeTabIdx,
    focusedPaneIdx,
    fullscreenPaneIdx,
    setFocusedPane,
    setFullscreenPane,
  } = useAppStore();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Skip if focus is inside an input/textarea/contenteditable
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;

      // F1–F5: navigate screens
      if (SCREEN_KEYS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setScreen(SCREEN_KEYS[e.key]);
        return;
      }

      // Ctrl+1–9: pane focus → fullscreen → restore state machine
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const targetIdx = parseInt(e.key, 10) - 1;

        const activeTab = tabs[activeTabIdx];
        const [cols, rows] = activeTab.layout.split("×").map(Number);
        if (targetIdx >= cols * rows) return;

        if (fullscreenPaneIdx === targetIdx) {
          // Fullscreened → restore to grid
          setFullscreenPane(-1);
          setFocusedPane(-1);
        } else if (focusedPaneIdx === targetIdx) {
          // Focused → fullscreen
          setFullscreenPane(targetIdx);
        } else {
          // Unfocused → focus (clear any existing fullscreen)
          setFullscreenPane(-1);
          setFocusedPane(targetIdx);
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setScreen, tabs, activeTabIdx, focusedPaneIdx, fullscreenPaneIdx, setFocusedPane, setFullscreenPane]);
}
