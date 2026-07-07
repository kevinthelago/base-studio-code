// Tree — the Layouts-tier template for tree-shaped data (#2476, epic #2197): org charts, file
// systems, category hierarchies. ONE component, two variants over the same recursive `nodes` prop:
//
//   • "indented" (default, file-explorer style) — collapsible nested rows (chevron toggle, depth
//     indentation, selection) in a MasterDetail rail, beside a detail panel for the selected node.
//     The ideal for DEEP / NAVIGATIONAL trees.
//   • "layered" (org-chart style) — a top-down layered chart riding the SHARED graph stack: the
//     pure `layoutTree` (layerDag #2214 + orderLayers #2418, see treeLayout.ts), the shared edge
//     grammar (`graphEdge` #2222, perimeter-anchor routing — the top-down precedent set by the
//     Design Studio composition graph #2455), and GraphCanvas + useGraphViewport (#2208) for
//     pan/zoom. The ideal for PRESENTATIONAL hierarchies.
//
// Selection is controlled (`selectedId` + `onSelect`) or uncontrolled (`defaultSelectedId`, the
// MasterDetail-tier idiom); expansion is uncontrolled (`defaultCollapsedIds`, `onToggle` notified).
// The `detail` slot (a node, or a render fn of the selected node) is the rail's detail column when
// indented and the canvas inspector when layered. Pure/presentational — data in via props only.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { MasterDetail } from "./MasterDetail";
import { GraphCanvas, ZoomControls } from "./GraphCanvas";
import { useGraphViewport } from "./useGraphViewport";
import { flattenTree, layoutTree, TREE_NODE_W, TREE_NODE_H, type TreeNodeData } from "./treeLayout";

export type { TreeNodeData } from "./treeLayout";

export type TreeVariant = "indented" | "layered";

export interface TreeProps {
  /** The tree roots — a recursive forest of { id, label, meta?, children? }. Ids must be unique. */
  nodes: TreeNodeData[];
  /** "indented" (default): collapsible rows + detail. "layered": top-down pan/zoom chart. */
  variant?: TreeVariant;
  /** Controlled selection — the selected node id (pair with onSelect). Omit for uncontrolled. */
  selectedId?: string | null;
  /** Uncontrolled: the initially selected node id. */
  defaultSelectedId?: string;
  /** Fires when a node is clicked (both modes; uncontrolled also updates the internal selection). */
  onSelect?: (id: string) => void;
  /** Detail panel for the selected node — a node, or a render fn of the selected TreeNodeData.
   *  Indented: the MasterDetail detail column; layered: the canvas inspector. */
  detail?: ReactNode | ((node: TreeNodeData | undefined) => ReactNode);
  /** Optional toolbar — full-width above the rail+detail (indented) / in the canvas toolbar row,
   *  before the zoom cluster (layered). */
  toolbar?: ReactNode;
  /** Indented: branch ids that start collapsed (expansion is uncontrolled). Default: all expanded. */
  defaultCollapsedIds?: string[];
  /** Fires when a branch toggles; `expanded` is the NEW state. */
  onToggle?: (id: string, expanded: boolean) => void;
  /** Indented: px of indentation per depth level. Default 16. */
  indent?: number;
  /** Indented: rail width in px (the starting width when `resizable`). Default 260. */
  railWidth?: number;
  /** Indented: opt into a drag-resizable rail (MasterDetail's splitter). Default false. */
  resizable?: boolean;
  /** Layered: inspector width in px when `detail` is provided. Default 300. */
  detailWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

const ELLIPSIS: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

export function Tree({
  nodes, variant = "indented",
  selectedId, defaultSelectedId, onSelect,
  detail, toolbar,
  defaultCollapsedIds, onToggle,
  indent = 16, railWidth = 260, resizable = false, detailWidth = 300,
  className,
}: TreeProps) {
  // Selection — controlled when the `selectedId` prop is present (may be null = none), else internal.
  const [innerSelected, setInnerSelected] = useState<string | null>(defaultSelectedId ?? null);
  const controlled = selectedId !== undefined;
  const selected = controlled ? selectedId : innerSelected;
  const select = (id: string) => {
    if (!controlled) setInnerSelected(id);
    onSelect?.(id);
  };

  // Expansion (indented) — uncontrolled: everything expanded except `defaultCollapsedIds`.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(defaultCollapsedIds));
  const toggle = (id: string) => {
    const expanding = collapsed.has(id);
    const next = new Set(collapsed);
    if (expanding) next.delete(id); else next.add(id);
    setCollapsed(next);
    onToggle?.(id, expanding);
  };

  const flat = useMemo(() => flattenTree(nodes), [nodes]);
  const selectedNode = flat.find((f) => f.node.id === selected)?.node;
  const detailNode = typeof detail === "function" ? detail(selectedNode) : detail;

  // The layered chart's world + viewport. Hooks always run (rules of hooks); they only drive the
  // layered variant, and the effect re-fits when the tree (world) changes.
  const layout = useMemo(() => layoutTree(nodes), [nodes]);
  const vp = useGraphViewport(layout.world);
  const { fit } = vp;
  useEffect(() => {
    if (variant === "layered") fit();
  }, [variant, fit, layout.world.w, layout.world.h]);

  if (variant === "layered") {
    return (
      <GraphCanvas
        vp={vp} world={layout.world} grid className={className}
        toolbar={
          <>
            {toolbar}
            <Spacer />
            <ZoomControls vp={vp} />
            <IconButton aria-label="fit tree" title="Fit" onClick={() => fit()}>⤢</IconButton>
          </>
        }
        inspector={detailNode ? (
          <Box pad={16} style={{
            flex: `0 0 ${detailWidth}px`, width: detailWidth, minWidth: 0,
            borderLeft: "1px solid var(--border-soft)", overflowY: "auto",
          }}>
            {detailNode}
          </Box>
        ) : undefined}
      >
        <svg width={layout.world.w} height={layout.world.h}
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
          {layout.edges.map((e) => {
            const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
            if (!a || !b) return null;
            // The shared line-type (#2222) with perimeter-anchor routing — the reading that works for
            // a layered TOP-DOWN flow (the side-port router is horizontal-only; see DesignStudio).
            const g = graphEdge({ ...a, w: TREE_NODE_W, h: TREE_NODE_H }, { ...b, w: TREE_NODE_W, h: TREE_NODE_H });
            return (
              <g key={e.id}>
                <path d={g.d} stroke="var(--border)" strokeWidth={1.5} fill="none" />
                <path d={g.arrow} fill="var(--border)" />
              </g>
            );
          })}
        </svg>
        {flat.map(({ node }) => {
          const p = layout.pos.get(node.id);
          if (!p) return null;
          const isSelected = selected === node.id;
          return (
            // data-node: the canvas ignores pans/backdrop-clicks that start on a node (#2208).
            <Stack key={node.id} data-node={node.id} data-selected={isSelected || undefined}
              gap={2} justify="center"
              onClick={() => select(node.id)}
              style={{
                position: "absolute", left: p.x, top: p.y, width: TREE_NODE_W, height: TREE_NODE_H,
                padding: "0 12px", borderRadius: 8, cursor: "pointer",
                background: isSelected ? "var(--accent-soft)" : "var(--bg-elev)",
                border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
              }}
            >
              <Text size={12} weight={600} style={ELLIPSIS}>{node.label}</Text>
              {node.meta && <Text size={10} tone="dim" mono style={ELLIPSIS}>{node.meta}</Text>}
            </Stack>
          );
        })}
      </GraphCanvas>
    );
  }

  // ── indented (file-explorer) — collapsible rows in a MasterDetail rail + the detail column ──
  const rows = (list: readonly TreeNodeData[], depth: number): ReactNode[] =>
    list.flatMap((n) => {
      const branch = !!n.children?.length;
      const isCollapsed = collapsed.has(n.id);
      const isSelected = selected === n.id;
      const row = (
        <Row key={n.id} role="treeitem" aria-selected={isSelected}
          aria-expanded={branch ? !isCollapsed : undefined}
          tabIndex={0} gap={4}
          onClick={() => select(n.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.id); }
          }}
          style={{
            padding: "4px 8px", paddingLeft: 6 + depth * indent, borderRadius: 6, cursor: "pointer",
            background: isSelected ? "var(--accent-soft)" : "transparent",
            border: `1px solid ${isSelected ? "var(--accent-dim)" : "transparent"}`,
          }}
        >
          {branch ? (
            <IconButton size="xs" aria-label={`${isCollapsed ? "expand" : "collapse"} ${n.label}`}
              onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>
              <Text as="span" size={9} tone="muted" style={{
                display: "inline-block", transition: "transform .12s ease",
                transform: isCollapsed ? "none" : "rotate(90deg)",
              }}>▶</Text>
            </IconButton>
          ) : (
            <Box as="span" style={{ display: "inline-block", width: 16, flex: "none" }} />
          )}
          <Text size={12} style={{ minWidth: 0, ...ELLIPSIS }}>{n.label}</Text>
          {n.meta && <Text size={10} tone="dim" mono style={{ marginLeft: "auto", flex: "none" }}>{n.meta}</Text>}
        </Row>
      );
      return branch && !isCollapsed ? [row, ...rows(n.children as TreeNodeData[], depth + 1)] : [row];
    });

  return (
    <MasterDetail
      className={className} toolbar={toolbar}
      railWidth={railWidth} railPad={8} resizable={resizable}
      rail={<Stack role="tree" gap={2}>{rows(nodes, 0)}</Stack>}
      detail={detailNode ?? null}
    />
  );
}
