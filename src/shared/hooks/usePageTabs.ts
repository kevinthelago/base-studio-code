// usePageTabs -- the shared per-page tab model (#463). Every page's tab bar uses
// this so behavior is identical: the tab order is persisted per page, the page
// "opens the first tab" (so the user's preferred view = whatever they drag to the
// front), reordering persists, and tear-off is wired in by the page.

import { useCallback, useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { moveInArray } from "@/shared/lib/core/arrayMove";
import { openDetachedSection } from "@/shared/lib/core/detachSection";
import type { TabItem } from "@/shared/ui/layouts/TabBar";

const EMPTY: string[] = [];

/**
 * Order `defs` by a persisted id list: known ids first (in persisted order),
 * then any defs not in the list (new tabs) appended in their canonical order;
 * stale ids in the list are ignored. Pure — unit-tested.
 */
export function orderTabs(defs: TabItem[], order: string[] | undefined): TabItem[] {
  if (!order || order.length === 0) return defs;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: TabItem[] = [];
  for (const id of order) {
    const d = byId.get(id);
    if (d) { out.push(d); byId.delete(id); }
  }
  for (const d of defs) if (byId.has(d.id)) out.push(d);
  return out;
}

export interface PageTabs {
  /** Visible tabs (persisted order, detached sections filtered out). */
  tabs: TabItem[];
  activeId: string;
  select: (id: string) => void;
  reorder: (from: number, to: number) => void;
  /** Tear a section into its own window: opens it, hides it from the bar, and
   *  moves focus off it if it was active. Returns on close/restart. */
  tearOff: (id: string) => void;
}

/**
 * Drive a page's tab bar: returns the persisted-ordered, detached-filtered tabs,
 * the active id (defaults to the first/front visible tab — the user's
 * preference), and select/reorder/tearOff handlers. `pageKey` namespaces both
 * the persisted order and the (session-only) detached set.
 *
 * Pass `controlled` when the active tab lives in the store and is shared across
 * components (e.g. the Projects board, where the bar and the content are separate
 * components) — the hook then reads/writes that instead of the persisted map.
 *
 * The uncontrolled active page is **persisted** per `pageKey` (`activePageTab`), so a
 * workspace reopens on the Page the user last viewed — across an in-session workspace
 * switch and across restart — falling back to the front tab (#463) when there's no
 * memory. A stale persisted id self-heals to the front tab via the validity effect.
 */
export function usePageTabs(
  pageKey: string,
  defs: TabItem[],
  controlled?: { activeId: string; setActive: (id: string) => void },
): PageTabs {
  const order = useAppStore((s) => s.pageTabOrder[pageKey]);
  const setOrder = useAppStore((s) => s.setPageTabOrder);
  const detached = useAppStore((s) => s.detachedSections[pageKey]) ?? EMPTY;
  const setDetached = useAppStore((s) => s.setSectionDetached);
  const persistedActive = useAppStore((s) => s.activePageTab[pageKey]);
  const setPersistedActive = useAppStore((s) => s.setActivePageTab);

  const ordered = useMemo(() => orderTabs(defs, order), [defs, order]);
  const tabs = useMemo(() => ordered.filter((t) => !detached.includes(t.id)), [ordered, detached]);
  const setUncontrolled = useCallback((id: string) => setPersistedActive(pageKey, id), [pageKey, setPersistedActive]);
  const activeId = controlled ? controlled.activeId : (persistedActive ?? tabs[0]?.id ?? "");
  const setActiveId = controlled ? controlled.setActive : setUncontrolled;

  // Keep the active id valid if the visible set changes (order/defs/detach shift):
  // a persisted id that no longer resolves to a visible tab heals to the front tab.
  // Skip while there are no tabs yet so we don't persist an empty selection.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === activeId)) setActiveId(tabs[0].id);
  }, [tabs, activeId, setActiveId]);

  // Reorder operates on visible positions; translate to the full ordered list so
  // detached sections keep their place.
  const reorder = useCallback((from: number, to: number) => {
    const fullIds = ordered.map((t) => t.id);
    const fromFull = fullIds.indexOf(tabs[from]?.id);
    const toFull = fullIds.indexOf(tabs[to]?.id);
    if (fromFull < 0 || toFull < 0) return;
    setOrder(pageKey, moveInArray(fullIds, fromFull, toFull));
  }, [pageKey, ordered, tabs, setOrder]);

  const tearOff = useCallback((id: string) => {
    const def = ordered.find((t) => t.id === id);
    openDetachedSection(pageKey, id, def?.label, () => setDetached(pageKey, id, false));
    setDetached(pageKey, id, true);
    if (activeId === id) {
      const next = tabs.find((t) => t.id !== id);
      if (next) setActiveId(next.id);
    }
  }, [pageKey, ordered, tabs, activeId, setDetached, setActiveId]);

  return { tabs, activeId, select: setActiveId, reorder, tearOff };
}
