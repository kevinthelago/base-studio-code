// The Algorithms page left rail (#2773) — the shared headerless graph-nav menu (#2797): a search box
// over collapsible per-kind sections of RailRows (the shared RailRow / RailSection primitives, #2789).
// Clicking a row selects + centers the node, so the rail reads like Glance/Designs/Teams. Search +
// section-collapse state are rail-local; selection state lives in the Workspace and comes via props.
import { useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailSection } from "@/shared/ui/layouts/RailSection";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { KIND_ORDER, KIND_META, type KnowledgeGraph } from "./lib/knowledge";

export function AlgorithmsRail({ graph, selected, onSelect }: {
  graph: KnowledgeGraph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useRailSections();
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  return (
    <GraphRail
      tools={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search nodes…"
          aria-label="Search nodes"
          style={{ width: "100%" }}
        />
      }
    >
      <Stack gap={4}>
        {KIND_ORDER.map((kind) => {
          const rows = graph.nodes.filter((n) => n.kind === kind && match(n.name));
          if (!rows.length) return null;
          return (
            <RailSection
              key={kind}
              label={KIND_META[kind].label}
              count={rows.length}
              open={sections.isOpen(kind)}
              onToggle={() => sections.toggle(kind)}
            >
              {rows.map((n) => (
                <RailRow
                  key={n.id}
                  active={n.id === selected}
                  onClick={() => onSelect(n.id)}
                  leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: KIND_META[kind].color }} />}
                >
                  {n.name}
                </RailRow>
              ))}
            </RailSection>
          );
        })}
      </Stack>
    </GraphRail>
  );
}
