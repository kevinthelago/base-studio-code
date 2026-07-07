// TreeExplorerPage — the Pages-tier composition for TREE-shaped data (#2505): a complete hierarchy
// explorer built strictly from kit components. The Tree template's INDENTED variant (#2476 — the
// ideal for deep/navigational trees: collapsible depth-indented rows in a MasterDetail rail) under a
// titled header bar, with a node DETAIL panel that renders the selected node's facts as a
// KeyValueList (label · id · meta · children count). Pure/presentational — the recursive `nodes`
// forest in via props is the whole data source.
//
// Selection follows the house idiom: controlled via `selectedId` + `onSelect`, else uncontrolled
// (`defaultSelectedId`); expansion stays uncontrolled (`defaultCollapsedIds`), as in Tree.
import type { ReactNode } from "react";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Tree, type TreeNodeData } from "@/shared/ui/layouts/Tree";
import { PageHeader } from "./pageHeader";

export type { TreeNodeData } from "@/shared/ui/layouts/Tree";

export interface TreeExplorerPageProps {
  /** Page title (the header bar). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Right-aligned header controls (search, filters, actions). */
  toolbar?: ReactNode;
  /** The tree roots — a recursive forest of { id, label, meta?, children? }. Ids must be unique. */
  nodes: TreeNodeData[];
  /** Controlled selection — the selected node id (pair with onSelect). Omit for uncontrolled. */
  selectedId?: string | null;
  /** Uncontrolled: the initially selected node id. */
  defaultSelectedId?: string;
  /** Fires with the clicked node's id (both selection modes). */
  onSelect?: (id: string) => void;
  /** Branch ids that start collapsed (expansion is uncontrolled). Default: all expanded. */
  defaultCollapsedIds?: string[];
  /** Detail panel override — a render fn of the selected node. Default: the node's facts as a KeyValueList. */
  detail?: (node: TreeNodeData) => ReactNode;
  /** Extra facts appended to the default detail's KeyValueList, derived from the selected node. */
  nodeFacts?: (node: TreeNodeData) => KeyValueItem[];
  /** Rail width in px. Default 260. */
  railWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function TreeExplorerPage({
  title, hint, toolbar,
  nodes,
  selectedId, defaultSelectedId, onSelect,
  defaultCollapsedIds,
  detail, nodeFacts, railWidth = 260, className,
}: TreeExplorerPageProps) {
  const defaultDetail = (node: TreeNodeData): ReactNode => (
    <Stack gap={12}>
      <Text size="md" weight={600}>{node.label}</Text>
      <KeyValueList mono items={[
        { k: "id", v: node.id },
        ...(node.meta != null ? [{ k: "meta", v: node.meta }] : []),
        { k: "children", v: `${node.children?.length ?? 0}` },
        ...(nodeFacts?.(node) ?? []),
      ]} />
    </Stack>
  );

  return (
    <Tree
      className={className}
      variant="indented"
      nodes={nodes}
      selectedId={selectedId}
      defaultSelectedId={defaultSelectedId}
      onSelect={onSelect}
      defaultCollapsedIds={defaultCollapsedIds}
      railWidth={railWidth}
      toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} />}
      detail={(node) =>
        node ? (detail?.(node) ?? defaultDetail(node)) : (
          <EmptyState iconVariant="dashed" icon="▤" size="sm" title="No node selected"
            description="Select a node in the tree to inspect it." />
        )
      }
    />
  );
}
