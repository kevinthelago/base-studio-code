import { useState, useEffect } from "react";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { openDetachedTab } from "@/app/console/lib/detachWindow";
import type { Tab } from "@/app/chrome/Tabstrip";
import { Dialog } from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";
import { NewTabDialog } from "./NewTabDialog";

/** The next free `tab-N` name (the highest existing N + 1). */
function nextTabName(tabs: Tab[]): string {
  const nums = tabs
    .map((t) => t.name.match(/^tab-(\d+)$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `tab-${nums.length === 0 ? 1 : Math.max(...nums) + 1}`;
}

export interface ConsoleTabsApi {
  /** Props to spread onto the <Tabstrip>. */
  tabstripProps: {
    tabs: Tab[];
    activeIdx: number;
    onSelect: (idx: number) => void;
    onClose: (idx: number) => void;
    onAdd: () => void;
    onRename: (idx: number, name: string) => void;
    onChangeLayout: (idx: number, layout: string) => void;
    onReorder: (from: number, to: number) => void;
    hiddenIds: string[];
    onTearOff: (idx: number) => void;
  };
  /** The new-tab + close-confirm dialogs (mount once at the app root). */
  dialogs: React.ReactNode;
  /** Open the new-tab dialog (e.g. from the empty state's CTA). */
  openNewTab: () => void;
}

/**
 * Owns the console's tab management — the layer that used to live in App.tsx. The console (not the
 * shell) owns its tabs: create (layout picker), close (PTY teardown + a confirm when a session is
 * live), layout change (kills the panes that vanish), reorder, and tear-off. Returns props for the
 * <Tabstrip> + the dialogs + an `openNewTab` for the empty state.
 */
export function useConsoleTabs(): ConsoleTabsApi {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabIdx = useAppStore((s) => s.activeTabIdx);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const detachedTabIds = useAppStore((s) => s.detachedTabIds);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const setTabLayout = useAppStore((s) => s.setTabLayout);
  const moveTab = useAppStore((s) => s.moveTab);
  const setTabDetached = useAppStore((s) => s.setTabDetached);

  const [confirmCloseIdx, setConfirmCloseIdx] = useState<number | null>(null);
  const [showNewTab, setShowNewTab] = useState(false);

  // ⌘T / Ctrl-T opens a new console tab (console screen only).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "t" && activeWorkspace === "console") {
        e.preventDefault();
        setShowNewTab(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeWorkspace]);

  function killTabPtys(tabIdx: number, layout: string) {
    const [c, r] = layout.split("×").map(Number);
    const tab = tabs[tabIdx];
    for (let i = 0; i < c * r; i++) {
      // Kill the pane's RESOLVED identity id (#1176) — manual panes are `man:<tabId>:p<idx>`,
      // so the old positional `t{tabIdx}p{i}` would miss the real session and leak it.
      fireInvoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }, console.error);
    }
  }

  function handleLayoutChange(tabIdx: number, layout: string) {
    const tab = tabs[tabIdx];
    const [oldCols, oldRows] = tab.layout.split("×").map(Number);
    const [newCols, newRows] = layout.split("×").map(Number);
    const oldCount = oldCols * oldRows;
    const newCount = newCols * newRows;
    // Kill PTY sessions for panes that will no longer exist (resolved identity id, #1176).
    if (newCount < oldCount) {
      for (let i = newCount; i < oldCount; i++) {
        fireInvoke("pty_kill", { paneId: paneIdFor(tab, tabIdx, i) }, console.error);
      }
    }
    setTabLayout(tabIdx, layout);
  }

  function handleCloseRequest(idx: number) {
    const tab = tabs[idx];
    if (tab.state === "run" || tab.state === "on") {
      setConfirmCloseIdx(idx);
    } else {
      killTabPtys(idx, tab.layout);
      closeTab(idx);
    }
  }

  function confirmClose() {
    if (confirmCloseIdx !== null) {
      killTabPtys(confirmCloseIdx, tabs[confirmCloseIdx].layout);
      closeTab(confirmCloseIdx);
    }
    setConfirmCloseIdx(null);
  }

  function handleTearOff(idx: number) {
    const t = tabs[idx];
    if (!t?.id) return;
    openDetachedTab(t.id, t.name, () => setTabDetached(t.id!, false));
    setTabDetached(t.id, true);
    // If the active tab was the one torn off, move focus to the first tab still in
    // the bar so the window isn't left on a hidden tab.
    if (activeTabIdx === idx) {
      const next = tabs.findIndex((x, i) => i !== idx && !detachedTabIds.includes(x.id ?? ""));
      if (next >= 0) setActiveTab(next);
    }
  }

  const pendingTab = confirmCloseIdx !== null ? tabs[confirmCloseIdx] : null;
  const activeSessionCount = pendingTab ? /* placeholder until real session tracking */ 1 : 0;

  const dialogs = (
    <>
      {confirmCloseIdx !== null && pendingTab && (
        <Dialog
          title={`Close "${pendingTab.name}"?`}
          danger
          onDismiss={() => setConfirmCloseIdx(null)}
          actions={
            <>
              <Button onClick={() => setConfirmCloseIdx(null)}>cancel</Button>
              <Button danger onClick={confirmClose}>close tab</Button>
            </>
          }
        >
          {activeSessionCount === 1
            ? "1 active session is running in this tab and will be stopped."
            : `${activeSessionCount} active sessions are running in this tab and will be stopped.`}
          {" "}This cannot be undone.
        </Dialog>
      )}
      {showNewTab && (
        <NewTabDialog
          onConfirm={(layout) => { addTab({ name: nextTabName(tabs), layout, state: "idle" }); setShowNewTab(false); }}
          onDismiss={() => setShowNewTab(false)}
        />
      )}
    </>
  );

  return {
    tabstripProps: {
      tabs,
      activeIdx: activeTabIdx,
      onSelect: setActiveTab,
      onClose: handleCloseRequest,
      onAdd: () => setShowNewTab(true),
      onRename: renameTab,
      onChangeLayout: handleLayoutChange,
      onReorder: moveTab,
      hiddenIds: detachedTabIds,
      onTearOff: handleTearOff,
    },
    dialogs,
    openNewTab: () => setShowNewTab(true),
  };
}
