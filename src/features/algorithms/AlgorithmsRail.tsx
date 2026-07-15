// The Algorithms page left rail (#2899) — a language-FOLDER tree mirroring the Components (Designs) rail
// (`RailTree` / `groupKits`): each LANGUAGE is a collapsible folder (like each technology is a folder
// there), with its implementations as the nested rows (primitives before algorithms, a role-tinted dot
// each). Clicking a folder head focuses that language (switches its graph) + toggles; clicking an impl
// selects it. The folder head is a caret RailRow with `active` and the rows are indented RailRows — the
// same shapes as the Designs kit head + component rows. Search + folder-open state are rail-local.
//
// #3120: an OPTIONAL domain filter COMPLEMENTS the language-folder view. When the library carries a
// domain facet, a "Filter by domain" dropdown appears; picking a domain narrows each language folder to
// that domain's collection (e.g. all `logistics` algorithms, across languages) — the language-folder
// structure is untouched, and with no domain selected (or none present) the rail reads exactly as before.
import { useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Dropdown } from "@/shared/ui/controls/Dropdown";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { groupImplsByLanguage, domainsOf, type KnowledgeGraph, type Tech } from "./lib/knowledge";

export function AlgorithmsRail({ graph, activeTech, selectedImpl, onSelectImpl, onSelectLang }: {
  graph: KnowledgeGraph;
  /** The active language — its folder head reads `active`. */
  activeTech: Tech;
  /** The selected implementation id (a leaf row). */
  selectedImpl: string | null;
  onSelectImpl: (id: string) => void;
  /** Focus a language (switch the graph to it) — clicking its folder head. */
  onSelectLang: (tech: Tech) => void;
}) {
  const [query, setQuery] = useState("");
  // The optional domain filter (#3120) — "" means all domains (the unfiltered language-folder view).
  const [domain, setDomain] = useState("");
  const folders = useRailSections(); // per-language folder open state (default OPEN)
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const groups = groupImplsByLanguage(graph);
  const domains = domainsOf(graph);
  // Ignore a stale selection whose domain the live graph no longer carries (fall back to "all").
  const activeDomain = domain && domains.includes(domain) ? domain : "";
  return (
    <GraphRail
      tools={
        <Stack gap={6}>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search…"
            aria-label="Search"
            style={{ width: "100%" }}
          />
          {domains.length > 0 && (
            <Dropdown
              value={activeDomain}
              onChange={setDomain}
              options={[{ value: "", label: "All domains" }, ...domains.map((d) => ({ value: d, label: d }))]}
              variant="field"
              size="sm"
              aria-label="Filter by domain"
              className="algo-domain-filter"
            />
          )}
        </Stack>
      }
    >
      {groups.map((g) => {
        const open = folders.isOpen(g.key);
        // Narrow to the selected domain (#3120), preserving the folder's primitives-then-algorithms order.
        const inDomain = activeDomain ? g.impls.filter((im) => im.domain === activeDomain) : g.impls;
        // A language with nothing in the active domain drops out of the filtered rail.
        if (activeDomain && inDomain.length === 0) return null;
        const rows = inDomain.filter((im) => match(im.name));
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
              trailing={<Text as="span" mono size="xxs" tone="dim">{inDomain.length}</Text>}
            >
              {g.label}
            </RailRow>
            {open && (
              <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
                {rows.map((im) => (
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
                ))}
                {rows.length === 0 && q && (
                  <Text size={11} tone="dim" as="div" style={{ padding: "6px 10px", fontStyle: "italic" }}>no matches</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </GraphRail>
  );
}
