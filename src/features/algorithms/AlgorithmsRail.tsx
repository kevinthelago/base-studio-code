// The Algorithms page left rail (#2773) — the shared headerless graph-nav menu (#2797): a search box
// over collapsible sections of RailRows (the shared RailRow / RailSection primitives, #2789). It leads
// with the active kit's free-standing PRIMITIVES (#2863 — the language building blocks that aren't
// concept nodes, otherwise unreachable), then the concept nodes grouped by kind. Clicking a concept row
// selects + centers the node; clicking a primitive shows its code in the inspector. Search +
// section-collapse state are rail-local; selection lives in the Workspace and comes via props.
import { useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailSection } from "@/shared/ui/layouts/RailSection";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { KIND_ORDER, KIND_META, TECH_META, kitImplsByRole, type KnowledgeGraph, type Tech } from "./lib/knowledge";

export function AlgorithmsRail({ graph, activeTech, selected, selectedImpl, onSelect, onSelectImpl }: {
  graph: KnowledgeGraph;
  /** The active language kit (#2863) — its free-standing primitives lead the rail. */
  activeTech: Tech;
  /** The selected concept node id (a kind-section row). */
  selected: string | null;
  /** The selected free-standing primitive impl id (a Primitives-section row). */
  selectedImpl: string | null;
  onSelect: (id: string) => void;
  onSelectImpl: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useRailSections();
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  // The active kit's FREE-STANDING primitives (#2863) — role primitive, no concept, so they don't appear
  // in the kind sections below; the concept-backed primitives (e.g. `merge`) are reachable via their node.
  const primitives = kitImplsByRole(graph, activeTech, "primitive").filter((im) => !im.concept && match(im.name));
  return (
    <GraphRail
      tools={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search…"
          aria-label="Search"
          style={{ width: "100%" }}
        />
      }
    >
      <Stack gap={4}>
        {primitives.length > 0 && (
          <RailSection
            label={`Primitives · ${TECH_META[activeTech]?.label ?? activeTech}`}
            count={primitives.length}
            open={sections.isOpen("__primitives")}
            onToggle={() => sections.toggle("__primitives")}
          >
            {primitives.map((im) => (
              <RailRow
                key={im.id}
                active={im.id === selectedImpl}
                onClick={() => onSelectImpl(im.id)}
                leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: "var(--violet)" }} />}
                trailing={<Text as="span" mono size="xxs" tone="dim">{im.id}</Text>}
              >
                {im.name}
              </RailRow>
            ))}
          </RailSection>
        )}
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
