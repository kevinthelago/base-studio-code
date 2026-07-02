// Tabstrip -- the console's workspace tab strip. Now a thin adapter over the
// shared <TabBar> (#463): it maps the console's index-based API to TabBar's
// generic id-based model (id = the tab's array index) and supplies the
// layout-picker context menu. All the drag/reorder/tear-off/rename behavior lives
// in TabBar, shared with every other page.

import { Pencil } from "lucide-react";
import { TabBar, type TabItem } from "./TabBar";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export interface Tab {
  /** Stable identity (#463), minted at creation. Survives reorder/close/detach,
   *  so the detached set, persisted order, and re-dock key off it (not the array
   *  index). Optional in the type for legacy/test literals; the store backfills
   *  one on hydration and mints one for every tab it creates. */
  id?: string;
  name: string;
  layout: string;
  state?: "run" | "on" | "idle";
  // Bumped when a tab's sessions are relaunched (e.g. triage re-run) so the panes
  // remount with fresh PTYs. Woven into ConsoleWorkspace's pane key; transient.
  runId?: number;
  // Stable project identity for fleet/triage tabs (#457): the sanitized projectKey
  // (a GitHub node id where possible). The reuse lookup matches on THIS, not the
  // derived `name`, so renaming the project relabels the tab without forking a
  // duplicate "· build"/"· triage" tab (the "two directors" bug). Absent for
  // ad-hoc / manually-named tabs.
  projectKey?: string;
  // Which kind of project tab this is (#457) — pairs with `projectKey` (+ `seq`) in
  // the reuse lookup. Absent for ad-hoc tabs.
  kind?: "build" | "triage";
  // 0-based build-tab sequence for multi-tab fleets (#457): 0 = primary "· build",
  // 1 = "· build 2", … Ignored for triage. Absent ⇒ 0.
  seq?: number;
  // Stable pane IDENTITY ids per grid cell (#1176), minted at fleet/triage launch
  // (`<projectKey>:<streamId>` / `:director` / `<projectKey>:<repo>:triage`). When present,
  // `paneIdFor` keys pane state/PTY/recovery off these instead of the grid position. Manual tabs
  // leave this unset and derive an ephemeral `man:<tabId>:p<idx>` id. Stage 2 populates it.
  paneIds?: string[];
}

const LAYOUTS = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"] as const;

interface TabstripProps {
  tabs: Tab[];
  activeIdx?: number;
  onSelect?: (idx: number) => void;
  onClose?: (idx: number) => void;
  onAdd?: () => void;
  onRename?: (idx: number, name: string) => void;
  onChangeLayout?: (idx: number, layout: string) => void;
  onReorder?: (from: number, to: number) => void;
  onTearOff?: (idx: number) => void;
  /** Tab ids to hide from the bar (detached into their own window, #430). */
  hiddenIds?: string[];
}

function LayoutMenu({ layout, onRename, onPick }: {
  layout?: string; onRename: () => void; onPick: (layout: string) => void;
}) {
  return (
    <>
      <button
        onClick={onRename}
        style={{
          width: "100%", padding: "7px 12px", background: "transparent", border: "none",
          color: "var(--fg-muted)", fontSize: 11.5, textAlign: "left", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 8,
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elev)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
      >
        <Pencil size={12} /> Rename
      </button>
      <Box bg="var(--border-soft)" style={{ height: 1, margin: "0 8px" }} />
      <Box style={{ padding: "6px 12px 10px" }}>
        <Text as="div" size={9.5} tone="dim" style={{ marginBottom: 7, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Layout
        </Text>
        <Row gap={5} align="stretch" wrap>
          {LAYOUTS.map((l) => {
            const [c, r] = l.split("×").map(Number);
            const current = layout === l;
            return (
              <button
                key={l}
                className="mono"
                onClick={() => onPick(l)}
                title={l}
                style={{
                  padding: "5px 7px", borderRadius: 4, cursor: "pointer",
                  fontSize: 10,
                  background: current ? "color-mix(in oklch, var(--accent), transparent 85%)" : "var(--bg-elev)",
                  border: "1px solid " + (current ? "var(--accent-dim)" : "var(--border-soft)"),
                  color: current ? "var(--accent)" : "var(--fg-muted)",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}
              >
                <Grid cols={`repeat(${c}, 8px)`} rows={`repeat(${r}, 5px)`} gap={1.5}>
                  {Array.from({ length: c * r }).map((_, idx) => (
                    <Box key={idx} bg={current ? "var(--accent)" : "var(--border)"} radius={1} />
                  ))}
                </Grid>
                {l}
              </button>
            );
          })}
        </Row>
      </Box>
    </>
  );
}

export function Tabstrip({
  tabs, activeIdx = 0, onSelect, onClose, onAdd, onRename, onChangeLayout, onReorder, onTearOff, hiddenIds = [],
}: TabstripProps) {
  // Identity is the stable tab id; fall back to the array index for legacy/test
  // tabs that predate ids. All console callbacks are index-based, so map back.
  const idOf = (i: number) => tabs[i]?.id ?? String(i);
  const idxOf = (id: string) => tabs.findIndex((_, i) => idOf(i) === id);
  // Detached tabs are hidden from the bar (still in the array, so their place is
  // kept). Reorder positions are in this visible subset → translate to full idx.
  const items: TabItem[] = tabs
    .map((t, i) => ({ id: idOf(i), label: t.name, status: t.state, meta: t.layout }))
    .filter((it) => !hiddenIds.includes(it.id));
  return (
    <TabBar
      tabs={items}
      activeId={idOf(activeIdx)}
      onSelect={(id) => onSelect?.(idxOf(id))}
      onAdd={onAdd}
      onClose={onClose ? (id) => onClose(idxOf(id)) : undefined}
      onRename={onRename ? (id, name) => onRename(idxOf(id), name) : undefined}
      onReorder={onReorder ? (from, to) => onReorder(idxOf(items[from].id), idxOf(items[to].id)) : undefined}
      onTearOff={onTearOff ? (id) => onTearOff(idxOf(id)) : undefined}
      renderMenu={(id, ctx) => (
        <LayoutMenu
          layout={tabs[idxOf(id)]?.layout}
          onRename={ctx.startRename}
          onPick={(l) => { onChangeLayout?.(idxOf(id), l); ctx.close(); }}
        />
      )}
    />
  );
}
