import { type ReactNode } from "react";
import { TabBar, type TabItem } from "./TabBar";

export interface TabbedScreenProps {
  /** The persisted-ordered, detached-filtered visible tabs (from `usePageTabs`). */
  tabs: TabItem[];
  /** The active section id the body renders + the bar highlights — i.e. `sectionOverride ?? activeId`
   *  (when a section is torn off the bar is hidden, so this doubles as the bar's selection). */
  active: string;
  onSelect: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onTearOff: (id: string) => void;
  /** Torn-off detached-section mode: render only the active body, with no tab bar. */
  sectionOverride?: string;
  /** Toolbar content on the right of the tab bar. */
  right?: ReactNode;
  /** Extra class on the root — a feature scoping hook (e.g. `"ext-screen"`) so the feature's own
   *  scoped CSS keeps applying on top of the shared `.screen` layout. */
  className?: string;
  /** Extra class on the body container (e.g. `"ext-body"` for feature padding/overrides). */
  bodyClassName?: string;
  /** The active section's body. */
  children: ReactNode;
  /** An overlay rendered as a sibling of the page inside the root (e.g. a drawer + scrim). */
  overlay?: ReactNode;
}

/**
 * The shared rail-screen shell (#1821). Collapses the boilerplate every tabbed rail screen repeated
 * — the conditional `<TabBar>` (hidden in a torn-off section) wrapped in the
 * `.screen / .screen-page / .screen-body` layout. **Controlled**: the screen owns the tab state
 * (`usePageTabs`) so it stays available to the screen's own effects / handlers / toolbar, and passes
 * it down here. A feature's existing scoping class rides along via `className` / `bodyClassName` (so
 * its component CSS is untouched), and a drawer/scrim mounts via `overlay`.
 */
export function TabbedScreen({
  tabs, active, onSelect, onReorder, onTearOff, sectionOverride, right, className, bodyClassName, children, overlay,
}: TabbedScreenProps) {
  return (
    <div className={className ? `screen ${className}` : "screen"}>
      <div className="screen-page">
        {!sectionOverride && (
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
