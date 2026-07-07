// NetworkPage — the Pages-tier composition for GRAPH-shaped data (#2505): a complete node/edge
// workspace built strictly from kit components. The GraphCanvas template (#2208 — pan/zoom viewport,
// dotted grid, toolbar row with ZoomControls + fit) over a typed `{ nodes, edges }` input laid out by
// the SHARED graph stack (networkLayout.ts: findBackEdges + layerDag + orderLayers + the #2222 edge
// grammar — zero forked graph logic, the same libs the Tree layered variant rides), plus a selected-
// node INSPECTOR that renders the node's facts (id · meta · in/out degree) as a KeyValueList.
// Pure/presentational — data in via props only.
//
// Selection follows the house idiom: controlled via `selectedId` + `onSelect`, else uncontrolled.
import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { usePageSelection } from "./useSelection";
import {
  layoutNetwork, NET_NODE_W, NET_NODE_H,
  type NetworkNodeData, type NetworkEdgeData,
} from "./networkLayout";

export type { NetworkNodeData, NetworkEdgeData } from "./networkLayout";

export interface NetworkPageProps {
  /** Page title (the toolbar row). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Extra toolbar controls, before the zoom cluster. */
  toolbar?: ReactNode;
  /** The graph's nodes — { id, label, meta? }. Ids must be unique. */
  nodes: NetworkNodeData[];
  /** The directed edges — { from, to, id? }; cycles are fine (layering breaks them, drawing keeps them). */
  edges: NetworkEdgeData[];
  /** Controlled selection — the selected node id (pair with onSelect). Omit for uncontrolled. */
  selectedId?: string | null;
  /** Uncontrolled: the initially selected node id. */
  defaultSelectedId?: string;
  /** Fires with the clicked node's id (both selection modes). */
  onSelect?: (id: string) => void;
  /** Inspector override — a render fn of the selected node. Default: label + facts KeyValueList. */
  detail?: (node: NetworkNodeData) => ReactNode;
  /** Inspector width in px when a node is selected. Default 300. */
  inspectorWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

const ELLIPSIS: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

export function NetworkPage({
  title, hint, toolbar,
  nodes, edges,
  selectedId, defaultSelectedId, onSelect,
  detail, inspectorWidth = 300, className,
}: NetworkPageProps) {
  const { selected, select } = usePageSelection(selectedId, defaultSelectedId, onSelect);
  const layout = useMemo(() => layoutNetwork(nodes, edges), [nodes, edges]);
  const vp = useGraphViewport(layout.world);
  const { fit } = vp;
  useEffect(() => { fit(); }, [fit, layout.world.w, layout.world.h]);

  const selectedNode = nodes.find((n) => n.id === selected);
  const degreeIn = layout.edges.filter((e) => e.to === selected).length;
  const degreeOut = layout.edges.filter((e) => e.from === selected).length;

  const defaultDetail = (node: NetworkNodeData): ReactNode => {
    const facts: KeyValueItem[] = [
      { k: "id", v: node.id },
      ...(node.meta != null ? [{ k: "meta", v: node.meta }] : []),
      { k: "in", v: `${degreeIn}` },
      { k: "out", v: `${degreeOut}` },
    ];
    return (
      <Stack gap={12}>
        <Text size="md" weight={600}>{node.label}</Text>
        <KeyValueList mono items={facts} />
      </Stack>
    );
  };

  return (
    <GraphCanvas
      vp={vp} world={layout.world} grid className={className}
      toolbar={
        <>
          <Text size="sm" weight={600}>{title}</Text>
          {hint != null && <Text size="xs" tone="dim">{hint}</Text>}
          {toolbar}
          <Spacer />
          <ZoomControls vp={vp} />
          <IconButton aria-label="fit graph" title="Fit" onClick={() => fit()}>⤢</IconButton>
        </>
      }
      inspector={selectedNode ? (
        <Box pad={16} style={{
          flex: `0 0 ${inspectorWidth}px`, width: inspectorWidth, minWidth: 0,
          borderLeft: "1px solid var(--border-soft)", overflowY: "auto",
        }}>
          {detail?.(selectedNode) ?? defaultDetail(selectedNode)}
        </Box>
      ) : undefined}
    >
      <svg width={layout.world.w} height={layout.world.h}
        style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
        {layout.edges.map((e) => {
          const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
          if (!a || !b) return null;
          // The shared line-type (#2222) with perimeter-anchor routing — the top-down reading the
          // Tree layered variant + the Design Studio composition graph established.
          const g = graphEdge({ ...a, w: NET_NODE_W, h: NET_NODE_H }, { ...b, w: NET_NODE_W, h: NET_NODE_H });
          return (
            <g key={e.id}>
              <path d={g.d} stroke="var(--border)" strokeWidth={1.5} fill="none" />
              <path d={g.arrow} fill="var(--border)" />
            </g>
          );
        })}
      </svg>
      {nodes.map((node) => {
        const p = layout.pos.get(node.id);
        if (!p) return null;
        const isSelected = selected === node.id;
        return (
          // data-node: the canvas ignores pans/backdrop-clicks that start on a node (#2208).
          <Stack key={node.id} data-node={node.id} data-selected={isSelected || undefined}
            gap={2} justify="center"
            onClick={() => select(node.id)}
            style={{
              position: "absolute", left: p.x, top: p.y, width: NET_NODE_W, height: NET_NODE_H,
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
