// ProjectsRail (#3802) — the Projects page's LEFT filter rail, modelled on the Skills library rail
// (`features/skills/index.tsx`): a `SearchField` at the top over collapsible `RailSection`s of facet
// rows — a Status facet AND an application-architecture Type facet (application · api · serverless
// · static · desktop · mobile · cli · library), with a "clear all filters" footer. Emits the active
// filters up (the composer owns the state so it survives re-renders). The drag-resize splitter + the
// sized wrapper live in the parent (`ProjectsList`), the same split the Skills rail uses.
//
// Each facet's on/off state is drawn with the `Toggle` pill switch (#3826, `xs` = 24×14 — the same
// height as the `Checkbox` it replaced, so row rhythm is unchanged). The Toggle is PRESENTATIONAL:
// `RailRow` renders a `<button>` that owns the click, and an interactive control nested inside a
// button is invalid — so the row carries `aria-pressed` and the switch is pure visual. Facets stay
// multi-select; only the affordance changed.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailSection } from "@/shared/ui/layouts/RailSection";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { STATUS_FACETS, TYPE_FACETS, type ProjectStatus, type AppType } from "./projectsFilter";

export interface ProjectsRailProps {
  query: string;
  /** Selected status facet values (empty ⇒ all). */
  statusSel: Set<ProjectStatus>;
  toggleStatus: (s: ProjectStatus) => void;
  /** Selected type (application-architecture) facet values (empty ⇒ all). */
  typeSel: Set<AppType>;
  toggleType: (t: AppType) => void;
  /** Live per-status counts (facet badges). */
  counts: Record<ProjectStatus, number>;
  /** Live per-type counts (facet badges). */
  typeCountsByCat: Record<AppType, number>;
  /** Total item count (the "All" row badge). */
  total: number;
  /** Clear the status facet only (the Status "All" row). */
  onClearStatus: () => void;
  /** Clear the type facet only (the Type "All" row). */
  onClearType: () => void;
  /** Clear search + all facets (the footer). */
  onClearFilters: () => void;
}

export function ProjectsRail({
  query, statusSel, toggleStatus, typeSel, toggleType,
  counts, typeCountsByCat, total, onClearStatus, onClearType, onClearFilters,
}: ProjectsRailProps) {
  const railSections = useRailSections();
  const anyFilter = statusSel.size > 0 || typeSel.size > 0 || query.trim().length > 0;

  return (
    // #3854: no `tools` — the search field moved to the list HEADER, where the primary control belongs.
    // `query` is still read here for `anyFilter`, which drives the clear-all-filters footer.
    <GraphRail
      bodyPad="12px 10px 20px"
      footer={anyFilter ? (
        <Box style={{ borderTop: "1px solid var(--border-soft)", padding: "10px 12px" }}>
          <Box as="button" onClick={onClearFilters} style={{ fontSize: 11, color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>
            clear all filters
          </Box>
        </Box>
      ) : undefined}
    >
      {/* Status — active / shipped / in progress / draft. */}
      <RailSection
        label="Status"
        count={STATUS_FACETS.length}
        open={railSections.isOpen("status")}
        onToggle={() => railSections.toggle("status")}
      >
        <RailRow
          active={statusSel.size === 0}
          onClick={onClearStatus}
          leading={<Box as="span" style={{ width: 13, textAlign: "center", color: statusSel.size === 0 ? "var(--accent)" : "var(--fg-dim)" }}>≡</Box>}
          trailing={<Text as="span" mono size={10} tone="dim">{total}</Text>}
        >
          All
        </RailRow>
        {STATUS_FACETS.map((f) => {
          const on = statusSel.has(f.value);
          return (
            <RailRow
              key={f.value}
              data-status={f.value}
              active={on}
              aria-pressed={on}
              onClick={() => toggleStatus(f.value)}
              leading={<>
                <Toggle on={on} size="xs" />
                <Box as="span" bg={f.dot} radius={99} style={{ width: 8, height: 8, flex: "0 0 8px", marginLeft: 6 }} />
              </>}
              trailing={<Text as="span" mono size={10} tone="dim">{counts[f.value]}</Text>}
            >
              <Box as="span" style={{ textTransform: "capitalize" }}>{f.label}</Box>
            </RailRow>
          );
        })}
      </RailSection>

      {/* Type — the application architecture (#3802): application · api · serverless · static ·
          desktop · mobile · cli · library. From the project's classification, else its deploy plan. */}
      <RailSection
        label="Type"
        count={TYPE_FACETS.length}
        open={railSections.isOpen("type")}
        onToggle={() => railSections.toggle("type")}
      >
        <RailRow
          active={typeSel.size === 0}
          onClick={onClearType}
          leading={<Box as="span" style={{ width: 13, textAlign: "center", color: typeSel.size === 0 ? "var(--accent)" : "var(--fg-dim)" }}>≡</Box>}
          trailing={<Text as="span" mono size={10} tone="dim">{total}</Text>}
        >
          All
        </RailRow>
        {TYPE_FACETS.map((f) => {
          const on = typeSel.has(f.value);
          return (
            <RailRow
              key={f.value}
              data-type={f.value}
              active={on}
              aria-pressed={on}
              onClick={() => toggleType(f.value)}
              leading={<>
                <Toggle on={on} size="xs" />
                <Box as="span" bg={f.color} radius={99} style={{ width: 8, height: 8, flex: "0 0 8px", marginLeft: 6 }} />
              </>}
              trailing={<Text as="span" mono size={10} tone="dim">{typeCountsByCat[f.value]}</Text>}
            >
              <Box as="span" style={{ textTransform: "capitalize" }}>{f.label}</Box>
            </RailRow>
          );
        })}
      </RailSection>
    </GraphRail>
  );
}
