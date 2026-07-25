// The Sounds page left rail (#3077) — a folder tree mirroring the Algorithms/Designs rails: a folder per
// cue CATEGORY (its cues as rows), then a Voices folder and a Primitives folder (the building blocks).
// Clicking a row selects that node (the graph pans to it + the inspector shows it). Search + folder-open
// state are rail-local.
import { useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { SOUND_CATEGORIES, CATEGORY_LABEL } from "./lib/soundDescriptor";
import { type SoundGraph, type SoundNode } from "./lib/soundGraph";

const KIND_DOT: Record<SoundNode["kind"], string> = {
  cue: "var(--accent)",
  voice: "var(--success)",
  primitive: "var(--violet)",
};

export function SoundsRail({ graph, selected, onSelect }: {
  graph: SoundGraph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const folders = useRailSections(); // per-folder open state (default OPEN)
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);

  const cues = graph.nodes.filter((n) => n.kind === "cue");
  const voices = graph.nodes.filter((n) => n.kind === "voice");
  const primitives = graph.nodes.filter((n) => n.kind === "primitive");

  // Folder sections: one per used category, then Voices + Primitives.
  const sections = [
    ...SOUND_CATEGORIES
      .filter((cat) => cues.some((c) => c.category === cat))
      .map((cat) => ({ key: `cat:${cat}`, label: CATEGORY_LABEL[cat], rows: cues.filter((c) => c.category === cat) })),
    { key: "voices", label: "Voices", rows: voices },
    { key: "primitives", label: "Primitives", rows: primitives },
  ];

  return (
    <GraphRail
      tools={<SearchField value={query} onChange={setQuery} placeholder="Search…" aria-label="Search sounds" style={{ width: "100%" }} />}
    >
      {sections.map((s) => {
        const open = folders.isOpen(s.key);
        const rows = s.rows.filter((n) => match(n.label));
        return (
          <Box key={s.key} style={{ marginBottom: 4 }}>
            <RailRow
              caret={open}
              weight={500}
              onClick={() => folders.toggle(s.key)}
              trailing={<Text as="span" mono size="xxs" tone="dim">{s.rows.length}</Text>}
            >
              {s.label}
            </RailRow>
            {open && (
              <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
                {rows.map((n) => (
                  <RailRow
                    key={n.id}
                    indent={1}
                    active={n.id === selected}
                    onClick={() => onSelect(n.id)}
                    leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: KIND_DOT[n.kind] }} />}
                    trailing={<Text as="span" mono size="xxs" tone="dim">{n.refId}</Text>}
                  >
                    {n.label}
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
