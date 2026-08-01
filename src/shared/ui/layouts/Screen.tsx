import { useEffect, type ReactNode } from "react";
import { TabBar, type TabItem } from "./TabBar";
import { PageBoundary } from "./PageBoundary";
import { setPageNav } from "./pageNav";
import { Box } from "@/shared/ui/layout/Box";

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
  // selector; `useHotkeys` does the matching, which also keeps every keyboard binding in ONE place.
  //
  // It goes to a MODULE REF, not the store (#4170). Store state made this a render loop: the Planner
  // subscribes to the whole store and passes a fresh inline `setActive`, so each publish re-rendered it,
  // which produced a new `select` identity, which published again. Nothing here needs reactivity — the
  // hotkey handler reads at keydown time — so a ref removes the whole class of bug rather than guarding
  // against it. No deps: the ref is rewritten on every render, which is free and cannot loop.
  //
  // `null` for a torn-off page: it renders a single Page and no bar, so there is nothing to step.
  useEffect(() => {
    setPageNav(pageOverride ? null : { ids: tabs.map((t) => t.id), active, select: onSelect });
  });
  // Clear on unmount only. Exactly one Screen is mounted per window, so this cannot race the next
  // Workspace's publish — that one runs in its own effect after this cleanup.
  useEffect(() => () => setPageNav(null), []);

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
        {/* The body is boundaried, the strip is NOT (#4170): a page that fails to render must not take
            the navigation with it — the tabs above stay clickable (and Ctrl+←/→ keeps working), so the
            user can always leave a broken page. */}
        <Box className={bodyClassName ? `screen-body ${bodyClassName}` : "screen-body"}>
          <PageBoundary page={pageOverride ?? active}>{children}</PageBoundary>
        </Box>
      </Box>
      {overlay}
    </Box>
  );
}
