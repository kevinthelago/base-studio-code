import { type ReactNode } from "react";
import { TabBar, type TabItem } from "./TabBar";

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
  /** Toolbar content on the right of the page-tab bar. */
  right?: ReactNode;
  /** Extra class on the root — a surface scoping hook (e.g. `"ext-screen"`) so the surface's own
   *  scoped CSS keeps applying on top of the shared `.screen` layout. */
  className?: string;
  /** Extra class on the body container (e.g. `"ext-body"` for surface padding/overrides). */
  bodyClassName?: string;
  /** The active page's body. */
  children: ReactNode;
  /** An overlay rendered as a sibling of the page inside the root (e.g. a drawer + scrim). */
  overlay?: ReactNode;
}

/**
 * The shared **Screen** shell (#1821, renamed #1878) — the root tabbed device every rail Surface
 * renders through. Collapses the boilerplate every tabbed surface repeated — the conditional
 * `<TabBar>` (the **PageTabs** strip, hidden in a torn-off page) wrapped in the
 * `.screen / .screen-page / .screen-body` layout. **Controlled**: the surface owns the page-tab
 * state (`usePageTabs`) so it stays available to the surface's own effects / handlers / toolbar,
 * and passes it down here. A surface's existing scoping class rides along via `className` /
 * `bodyClassName` (so its component CSS is untouched), and a drawer/scrim mounts via `overlay`.
 *
 * Vocabulary (#1878): the **Rail** switches **Surfaces**; a Surface is composed of a **Screen** that
 * shows one **Page** at a time; the page-tab strip is **PageTabs**. See `docs/frontend-structure.md`.
 */
export function Screen({
  tabs, active, onSelect, onReorder, onTearOff, pageOverride, right, className, bodyClassName, children, overlay,
}: ScreenProps) {
  return (
    <div className={className ? `screen ${className}` : "screen"}>
      <div className="screen-page">
        {!pageOverride && (
          <TabBar
            tabs={tabs}
            activeId={active}
            onSelect={onSelect}
            onReorder={onReorder}
            onTearOff={onTearOff}
            right={right}
          />
        )}
        <div className={bodyClassName ? `screen-body ${bodyClassName}` : "screen-body"}>
          {children}
        </div>
      </div>
      {overlay}
    </div>
  );
}
