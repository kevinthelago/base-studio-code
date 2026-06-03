// usePageTabs -- the shared per-page tab model (#463). Every page's tab bar uses
// this so behavior is identical: the tab order is persisted per page, the page
// "opens the first tab" (so the user's preferred view = whatever they drag to the
// front), reordering persists, and tear-off is wired in by the page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import { moveInArray } from "../lib/tabReorder";
import type { TabItem } from "../components/chrome/TabBar";

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
  tabs: TabItem[];
  activeId: string;
  select: (id: string) => void;
  reorder: (from: number, to: number) => void;
}

/**
 * Drive a page's tab bar: returns the persisted-ordered tabs, the active id
 * (defaults to the first/front tab — the user's preference), and select/reorder
 * handlers. `pageKey` namespaces the persisted order.
 */
export function usePageTabs(pageKey: string, defs: TabItem[]): PageTabs {
  const order = useAppStore((s) => s.pageTabOrder[pageKey]);
  const setOrder = useAppStore((s) => s.setPageTabOrder);

  const tabs = useMemo(() => orderTabs(defs, order), [defs, order]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? "");

  // Keep the active id valid if the tab set changes (e.g. order/defs shift).
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeId)) setActiveId(tabs[0]?.id ?? "");
  }, [tabs, activeId]);

  const reorder = useCallback(
    (from: number, to: number) => setOrder(pageKey, moveInArray(tabs.map((t) => t.id), from, to)),
    [pageKey, tabs, setOrder],
  );

  return { tabs, activeId, select: setActiveId, reorder };
}
