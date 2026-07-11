// The Algorithms page left rail (#2773 · #2863) — the shared headerless graph-nav menu (#2797): a search
// box over collapsible sections of RailRows (the shared RailRow / RailSection primitives, #2789). It leads
// with the "Kits" between-language navigation, then the ACTIVE kit's implementations grouped by role —
// "Primitives" (the language building blocks) and "Algorithms" (the composed ones). A concept IS its
// implementation, so every row is an impl node in the per-kit graph; clicking one selects + centers it.
// Search + section-collapse state are rail-local; selection lives in the Workspace and comes via props.
import { useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailSection } from "@/shared/ui/layouts/RailSection";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { TECH_META, kitTechs, kitImpls, kitImplsByRole, type AlgoImpl, type ImplRole, type KnowledgeGraph, type Tech } from "./lib/knowledge";

/** Per-role rail treatment — the section label + the row's leading-dot color. */
const ROLE_SECTIONS: { role: ImplRole; label: string; color: string }[] = [
  { role: "primitive", label: "Primitives", color: "var(--violet)" },
  { role: "algorithm", label: "Algorithms", color: "var(--accent)" },
];

export function AlgorithmsRail({ graph, activeTech, selectedImpl, onSelectImpl, onSelectKit }: {
  graph: KnowledgeGraph;
  /** The active language kit (#2863) — its implementations fill the rail. */
  activeTech: Tech;
  /** The selected implementation id (a node in the per-kit graph). */
  selectedImpl: string | null;
  onSelectImpl: (id: string) => void;
  /** Switch to / drill into a language kit (#2863) — the rail's between-kits navigation. */
  onSelectKit: (tech: Tech) => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useRailSections();
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const kits = kitTechs(graph).filter((t) => match(TECH_META[t]?.label ?? t));
  const row = (im: AlgoImpl, color: string) => (
    <RailRow
      key={im.id}
      active={im.id === selectedImpl}
      onClick={() => onSelectImpl(im.id)}
      leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: color }} />}
      trailing={<Text as="span" mono size="xxs" tone="dim">{im.id}</Text>}
    >
      {im.name}
    </RailRow>
  );
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
        {kits.length > 0 && (
          <RailSection
            label="Kits"
            count={kits.length}
            open={sections.isOpen("__kits")}
            onToggle={() => sections.toggle("__kits")}
          >
            {kits.map((t) => (
              <RailRow
                key={t}
                active={t === activeTech}
                onClick={() => onSelectKit(t)}
                leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} />}
                trailing={<Text as="span" mono size="xxs" tone="dim">{kitImpls(graph, t).length}</Text>}
              >
                {TECH_META[t]?.label ?? t}
              </RailRow>
            ))}
          </RailSection>
        )}
        {ROLE_SECTIONS.map(({ role, label, color }) => {
          const impls = kitImplsByRole(graph, activeTech, role).filter((im) => match(im.name));
          if (!impls.length) return null;
          return (
            <RailSection
              key={role}
              label={`${label} · ${TECH_META[activeTech]?.label ?? activeTech}`}
              count={impls.length}
              open={sections.isOpen(role)}
              onToggle={() => sections.toggle(role)}
            >
              {impls.map((im) => row(im, color))}
            </RailSection>
          );
        })}
      </Stack>
    </GraphRail>
  );
}
