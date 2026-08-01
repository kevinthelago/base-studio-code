// The Design Studio rail tree (#2717) — extracted from DesignStudio.tsx, mirroring how `GraphView` and
// `Inspector` are their own components. Renders the kits→components tree: technology → style group
// headers (default OPEN) down to the collapsible kit heads and their search-filtered component rows.
// Pure presentational — all selection/expand state lives in the parent (`DesignStudio`) and is threaded
// through props. The rows/headers now render through the shared RailRow / RailGroupHeader nav primitives
// (#2789); the `ds-grouphead`/`ds-kithead`/`ds-comprow` classes remain only as selector/test hooks (the
// styling is the canonical shared look, no longer their own CSS).
//
// #4128 lifted the folder LEVEL out of here into `shared/`: the folder glyph + header row are now
// `RailFolderRow`, and the tree they render is built by the shared `buildFolderTree`. Both are used
// verbatim by the Algorithms rail, so the two library rails are the same rail rather than lookalikes.
import { type ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailGroupHeader } from "@/shared/ui/layouts/RailGroupHeader";
import { RailFolderRow, RailFolderChildren } from "@/shared/ui/layouts/RailFolderRow";
import { RoleDot } from "./kitChrome";
import type { ComponentRecord, Kit } from "./lib/model";
import { type KitTreeNode, type ComponentFolder, groupComponentsByFolder, folderComponentCount } from "./lib/kitGroups";
import { byTier } from "./lib/compositionLayout";

interface RailTreeProps {
  /** The technology → style rail hierarchy (from `groupKits`). */
  railTree: KitTreeNode[];
  /** Per-key expand state (kit id or group key → open) + its setter. */
  expanded: Record<string, boolean>;
  setExpanded: (updater: (e: Record<string, boolean>) => Record<string, boolean>) => void;
  /** The active kit (its head shows `.active`). */
  kitId: string;
  setKitId: (id: string) => void;
  /** The focused component id (its row shows `.on` when in the active kit). */
  compId: string | null;
  /** The full component library (rows are filtered per-kit by `match`). */
  components: ComponentRecord[];
  /** The search-filter predicate (`matchesQuery(c, query)`). */
  match: (c: ComponentRecord) => boolean;
  /** Focus a component row. */
  selectComp: (c: ComponentRecord) => void;
  /** The current search query — drives the "no matches" placeholder. */
  query: string;
}

export function RailTree({ railTree, expanded, setExpanded, kitId, setKitId, compId, components, match, selectComp, query }: RailTreeProps) {
  // One rail kit entry: the collapsible kit head + its (search-filtered) component rows. Under the
  // #2506 single-kit style merge this IS the style header — `label` shows the style name instead of
  // the kit name (the kit identity stays in the tooltip), and no separate kit row renders.
  const renderRailKit = (k: Kit, label?: string) => {
    const open = !!expanded[k.id];
    const inKit = components.filter((c) => c.kitId === k.id);
    const rows = inKit.filter(match).sort(byTier); // Pages on top, like the graph (#2976)
    // One component row — shared by the flat list and the per-group nesting (#3048).
    const renderCompRow = (c: ComponentRecord) => (
      <RailRow
        key={c.id}
        className="ds-comprow"
        indent={1}
        active={c.id === compId && k.id === kitId}
        onClick={() => selectComp(c)}
        leading={<RoleDot role={c.role} size={7} glow={3} />}
        trailing={<Text mono size="xxs" tone="dim" style={{ padding: "1px 5px", background: "var(--bg-soft)", borderRadius: 4 }}>×{c.used}</Text>}
      >
        {c.name}
      </RailRow>
    );
    // One folder of the kit's tree (#3582): a collapsible header (default OPEN), its subfolders
    // (recursion), then its direct component rows. Expand state is namespaced by kit so two kits'
    // identically-named folders (`shared/ui`) don't share a toggle. Mirrors a file explorer:
    // subfolders list before a folder's own files. Rendered as a readable RailRow (#3632) — a folder
    // glyph + caret + `weight:500`, the same fg-muted→fg row look as the leaves — NOT the dim uppercase
    // micro-label it used to wear (which was hard to read for what is the browsable tree here).
    const renderFolder = (f: ComponentFolder): ReactNode => {
      const fkey = `${k.id}::${f.key}`;
      const open = expanded[fkey] ?? true;
      return (
        <Box key={f.key} className="ds-compfolder" style={{ marginBottom: 2 }}>
          <RailFolderRow
            className="ds-compfolderhead"
            label={f.label}
            count={folderComponentCount(f)}
            open={open}
            onToggle={() => setExpanded((e) => ({ ...e, [fkey]: !(e[fkey] ?? true) }))}
            ungrouped={f.ungrouped}
            path={f.key}
          />
          {open && (
            <RailFolderChildren>
              {f.folders.map(renderFolder)}
              {f.items.map(renderCompRow)}
            </RailFolderChildren>
          )}
        </Box>
      );
    };
    // When this kit's components carry `group` folder paths, render them as a nested folder tree
    // (#3582); otherwise `folders` is null and the flat list renders EXACTLY as before (zero regression).
    const folders = groupComponentsByFolder(rows);
    return (
      <Box key={k.id} style={{ marginBottom: 4 }}>
        <RailRow
          className="ds-kithead"
          caret={open}
          active={k.id === kitId}
          weight={500}
          title={label ? `${label} · ${k.name} — ${k.stack}` : k.stack}
          onClick={() => { setKitId(k.id); setExpanded((e) => ({ ...e, [k.id]: !e[k.id] })); }}
          leading={<ColorSwatch color={k.dot} size={7} />}
          trailing={<Text mono size="xxs" tone="dim">{inKit.length}</Text>}
        >
          {label ?? k.name}
        </RailRow>
        {open && (
          <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
            {folders ? folders.map(renderFolder) : rows.map(renderCompRow)}
            {rows.length === 0 && query && (
              <Text size={11} tone="dim" as="div" style={{ padding: "6px 10px", fontStyle: "italic" }}>no matches</Text>
            )}
          </Box>
        )}
      </Box>
    );
  };
  // A rail tree node: a kit entry, or a collapsible tech/style group header (default OPEN — its
  // expand state shares the `expanded` record under the group's stable key). A single-kit style
  // group (#2506) renders as the kit entry labelled with the style — the style header IS the kit.
  const renderRailNode = (n: KitTreeNode): ReactNode => {
    if (n.kind === "kit") return renderRailKit(n.kit);
    if (n.kit) return renderRailKit(n.kit, n.label);
    const open = expanded[n.key] ?? true;
    return (
      <Box key={n.key} style={{ marginBottom: 4 }}>
        <RailGroupHeader
          className="ds-grouphead"
          collapsible
          open={open}
          onToggle={() => setExpanded((e) => ({ ...e, [n.key]: !(e[n.key] ?? true) }))}
          count={n.count}
          title={`${n.level === "tech" ? "technology" : "visual language"}: ${n.label}`}
        >
          {n.label}
        </RailGroupHeader>
        {open && <Box className="ds-groupkids">{n.children.map(renderRailNode)}</Box>}
      </Box>
    );
  };

  return <>{railTree.map(renderRailNode)}</>;
}
