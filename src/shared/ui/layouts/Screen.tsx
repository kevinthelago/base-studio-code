import { useEffect, useMemo, type ReactNode } from "react";
import { TabBar, type TabItem } from "./TabBar";
import { Box } from "@/shared/ui/layout/Box";
import { useAppStore } from "@/store";

export interface ScreenProps {
  /** The persisted-ordered, detached-filtered visible page tabs (from `usePageTabs`). */
  tabs: TabItem[];
  /** The active page id the body renders + the bar highlights — i.e. `pageOverride ?? activeId`
   *  (when a page is torn off the bar is hidden, so this doubles as the bar's selection). */
  active: string;
  onSelect: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onTearOff: (id: string) => void;
  /** Torn-off detached-page mode: render only the active body, with no page-tab bar. */
  pageOverride?: string;
  /** Extra class on the root — a workspace scoping hook (e.g. `"ext-workspace"`) so the workspace's own
   *  scoped CSS keeps applying on top of the shared `.screen` layout. */
  className?: string;
  /** Extra class on the body container (e.g. `"ext-body"` for workspace padding/overrides). */
  bodyClassName?: string;
  /** The active page's body. */
  children: ReactNode;
  /** An overlay rendered as a sibling of the page inside the root (e.g. a drawer + scrim). */
  overlay?: ReactNode;
}

/**
 * The shared **Screen** shell (#1821, renamed #1878) — the root tabbed device every rail Workspace
 * renders through. Collapses the boilerplate every tabbed workspace repeated — the conditional
 * `<TabBar>` (the **PageTabs** strip, hidden in a torn-off page) wrapped in the
 * `.screen / .screen-page / .screen-body` layout. **Controlled**: the workspace owns the page-tab
 * state (`usePageTabs`) so it stays available to the workspace's own effects / handlers / toolbar,
 * and passes it down here. A workspace's existing scoping class rides along via `className` /
 * `bodyClassName` (so its component CSS is untouched), and a drawer/scrim mounts via `overlay`.
 *
 * Vocabulary (#1878): the **Rail** switches **Workspaces**; a Workspace is composed of a **Screen** that
 * shows one **Page** at a time; the page-tab strip is **PageTabs**. See `docs/frontend-structure.md`.
 */
export function Screen({
  tabs, active, onSelect, onReorder, onTearOff, pageOverride, className, bodyClassName, children, overlay,
}: ScreenProps) {
  // Publish the live PageTabs so the shell's keyboard owner can step them with Ctrl+←/→ (#4167).
  //
  // Publishing rather than binding the keys here is a deliberate INVERSION: `shared/` may not import
  // value symbols from `features/` or `app/` (#1626/#1703), so this module cannot match a keybinding —
  // and duplicating the chord logic locally would leave it to drift. It hands over plain data + its own
  // selector; `useHotkeys` (which legitimately knows every feature) does the matching, which also keeps
  // every keyboard binding in ONE place.
  //
  // `null` for a torn-off page: it renders a single Page and no bar, so there is nothing to step.
  const setPageNav = useAppStore((s) => s.setPageNav);
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  useEffect(() => {
    if (pageOverride) {
      setPageNav(null);
      return;
    }
    setPageNav({ ids, active, select: onSelect });
    // Exactly one Screen is mounted at a time, so clearing on unmount cannot race another Workspace's
    // publish — the next one publishes in its own effect.
    return () => setPageNav(null);
  }, [ids, active, onSelect, pageOverride, setPageNav]);

  return (
    <Box className={className ? `screen ${className}` : "screen"}>
      <Box className="screen-page">
        {!pageOverride && (
          <TabBar
            tabs={tabs}
            activeId={active}
            onSelect={onSelect}
            onReorder={onReorder}
            onTearOff={onTearOff}
          />
        )}
        <Box className={bodyClassName ? `screen-body ${bodyClassName}` : "screen-body"}>
          {children}
        </Box>
      </Box>
      {overlay}
    </Box>
  );
}
