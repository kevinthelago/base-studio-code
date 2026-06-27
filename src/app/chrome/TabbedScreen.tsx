import { type ReactNode } from "react";
import { TabBar, type TabItem } from "./TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";

type SelectFn = (id: string) => void;

export interface TabbedScreenProps {
  /** Persisted tab-order namespace (the `usePageTabs` key). */
  pageKey: string;
  /** The tab definitions. */
  defs: TabItem[];
  /** Torn-off detached-section mode: render only the named section's body, no tab bar. */
  sectionOverride?: string;
  /** Toolbar content on the right of the tab bar. A function form receives `select`
   *  so a toolbar button can switch tabs. */
  right?: ReactNode | ((select: SelectFn) => ReactNode);
  /** Extra class on the root — a feature scoping hook (e.g. `"ext-screen"`) so the
   *  feature's own scoped CSS keeps applying on top of the shared `.screen` layout. */
  className?: string;
  /** Extra class on the body container (e.g. `"ext-body"` for feature padding/overrides). */
  bodyClassName?: string;
  /** Render the active section's body. Receives the resolved active id
   *  (`sectionOverride ?? activeId`) and `select` for programmatic tab switches. */
  renderBody: (active: string, select: SelectFn) => ReactNode;
  /** An overlay rendered as a sibling of the page inside the root (e.g. a drawer + scrim). */
  overlay?: ReactNode;
}

/**
 * The shared rail-screen shell (#1821). Collapses the boilerplate every tabbed rail screen
 * repeated — `usePageTabs` + `active = sectionOverride ?? activeId` + the conditional `<TabBar>`
 * (hidden in a torn-off section) + the `.screen / .screen-page / .screen-body` layout — into one
 * component. A feature's existing scoping class rides along via `className` / `bodyClassName` (so
 * its component CSS is untouched), and a drawer/scrim mounts via `overlay`.
 */
export function TabbedScreen({
  pageKey, defs, sectionOverride, right, className, bodyClassName, renderBody, overlay,
}: TabbedScreenProps) {
  const { tabs, activeId, select, reorder, tearOff } = usePageTabs(pageKey, defs);
  const active = sectionOverride ?? activeId;
  return (
    <div className={className ? `screen ${className}` : "screen"}>
      <div className="screen-page">
        {!sectionOverride && (
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={select}
            onReorder={reorder}
            onTearOff={tearOff}
            right={typeof right === "function" ? right(select) : right}
          />
        )}
        <div className={bodyClassName ? `screen-body ${bodyClassName}` : "screen-body"}>
          {renderBody(active, select)}
        </div>
      </div>
      {overlay}
    </div>
  );
}
