// The Algorithms page left rail (#2899/#4107/#4128) — the SAME structure the Components (Designs) rail
// renders, level for level:
//
//   Designs      kit head        →  folder tree (`groupComponentsByFolder`)  →  component rows
//   Algorithms   LANGUAGE head   →  folder tree (`folderTree`)               →  impl rows
//
// A language kit IS the algorithms analogue of a component kit (`kitImpls`/`kitGraph` are per-`tech`,
// each language has its own graph and its own dot), so the top level is a deliberate 1:1 mapping, not a
// divergence. Below it both rails build their tree with the ONE shared `buildFolderTree` and draw
// folders with the ONE shared `RailFolderRow` — so "the two libraries are presented the same" is
// enforced by construction rather than by two implementations agreeing.
//
// #4128 removed the "Filter by domain" dropdown (#3120). `domain` derives from the same `src` the folder
// path does, only COLLAPSED to a single segment, so surfacing it as a top-level selector offered a
// second, lossier organizer for the axis the folder tree already covers — and implied the library was
// organized by domain. Components never had an equivalent control. Search is the rail's one filter, and
// it matches the folder path (`matchesImpl`), which is how a folder is narrowed to now.
import { type ReactNode, useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailFolderRow, RailFolderChildren } from "@/shared/ui/layouts/RailFolderRow";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  groupImplsByLanguage, folderTree, folderImplCount, matchesImpl,
  type AlgoImpl, type AlgoFolderNode, type AlgoLangGroup, type KnowledgeGraph, type Tech,
} from "./lib/knowledge";

export function AlgorithmsRail({ graph, activeTech, selectedImpl, onSelectImpl, onSelectLang }: {
  graph: KnowledgeGraph;
  /** The active language — its head reads `active`, like the Designs rail's active kit. */
  activeTech: Tech;
  /** The selected implementation id (a leaf row). */
  selectedImpl: string | null;
  onSelectImpl: (id: string) => void;
  /** Focus a language (switch the graph to it) — clicking its head. */
  onSelectLang: (tech: Tech) => void;
}) {
  const [query, setQuery] = useState("");
  const folders = useRailSections(); // language + folder open state (default OPEN)
  const groups = groupImplsByLanguage(graph);

  // One language entry: the collapsible language head + its (search-filtered) folder tree. Mirrors
  // `RailTree`'s `renderRailKit`.
  const renderLanguage = (g: AlgoLangGroup) => {
    const open = folders.isOpen(g.key);
    const rows = g.impls.filter((im) => matchesImpl(im, query));

    // One impl row — the leaf, at the same depth every component row sits at in the Designs rail.
    const renderImplRow = (im: AlgoImpl): ReactNode => (
      <RailRow
        key={im.id}
        className="algo-implrow"
        indent={1}
        active={im.id === selectedImpl}
        onClick={() => onSelectImpl(im.id)}
        leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: im.role === "primitive" ? "var(--violet)" : "var(--accent)" }} />}
        trailing={<Text as="span" mono size="xxs" tone="dim">{im.id}</Text>}
      >
        {im.name}
      </RailRow>
    );

    // One folder of the language's tree: the shared header, its subfolders (recursion), then its direct
    // impl rows. Expand state is namespaced by language so two languages' identically-named folders
    // (`shared/lib/algorithms`) don't share a toggle. A collapsed folder doesn't render its subtree at
    // all, which matters for a harvested library carrying hundreds of impls across dozens of folders.
    const renderFolder = (f: AlgoFolderNode): ReactNode => {
      const fkey = `${g.key}::${f.key}`;
      const fopen = folders.isOpen(fkey);
      return (
        <Box key={f.key} className="algo-implfolder" style={{ marginBottom: 2 }}>
          <RailFolderRow
            className="algo-folderhead"
            label={f.label}
            count={folderImplCount(f)}
            open={fopen}
            onToggle={() => folders.toggle(fkey)}
            ungrouped={f.ungrouped}
            path={f.key}
          />
          {fopen && (
            <RailFolderChildren>
              {f.folders.map(renderFolder)}
              {f.items.map(renderImplRow)}
            </RailFolderChildren>
          )}
        </Box>
      );
    };

    // When this language's impls carry folder paths, render the nested tree; otherwise `tree` is null
    // and the flat impl list renders exactly as it would without folders.
    const tree = folderTree(rows);
    return (
      <Box key={g.key} style={{ marginBottom: 4 }}>
        <RailRow
          className="algo-langhead"
          caret={open}
          active={g.tech === activeTech}
          weight={500}
          title={`language: ${g.label}`}
          onClick={() => { onSelectLang(g.tech); folders.toggle(g.key); }}
          leading={<ColorSwatch color={g.dot} size={7} />}
          trailing={<Text as="span" mono size="xxs" tone="dim">{g.impls.length}</Text>}
        >
          {g.label}
        </RailRow>
        {open && (
          <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
            {tree ? tree.map(renderFolder) : rows.map(renderImplRow)}
            {rows.length === 0 && query.trim() && (
              <Text size={11} tone="dim" as="div" style={{ padding: "6px 10px", fontStyle: "italic" }}>no matches</Text>
            )}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <GraphRail
      tools={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search algorithms…"
          aria-label="Search"
          style={{ width: "100%" }}
        />
      }
    >
      {groups.map(renderLanguage)}
    </GraphRail>
  );
}
