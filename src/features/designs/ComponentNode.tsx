// ComponentNode (#4132) — ONE node of the Design Studio composition graph, extracted from
// `DesignsWorkbench` and MEMOIZED.
//
// It was inline JSX in the page component, so all 248 nodes re-rendered on any parent state change. The
// scan writes that populate `componentBuildStatus`/`componentStateHealth` made that pathological: the
// measured churn was 125 `[render] designs update` commits at ~24ms each. Batching those writes (#4132)
// cuts the COMMIT COUNT; memoizing here cuts the cost of each remaining commit, so a status landing for
// one component re-renders one node rather than the whole graph.
//
// The props are deliberately PRIMITIVE (x/y/selected/related/working) rather than the objects they were
// derived from — `pos`, the `relatedNodes` Set and the `nodeHealth` Map are all rebuilt each render, so
// passing them would defeat the memo on identity alone. `onSelect` takes the record, letting the parent
// pass ONE stable callback instead of a fresh closure per node.
import { memo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { RoleDot } from "./kitChrome";
import { HEALTH_BADGE, type HealthCategory } from "./lib/graphHealth";
import { NODE_W } from "./lib/compositionLayout";
import type { ComponentBuildStatus } from "./lib/componentScan";
import type { ComponentRecord } from "./lib/model";

export interface ComponentNodeProps {
  c: ComponentRecord;
  x: number;
  y: number;
  /** The user's focused node — the full ring. Wins over {@link related} and {@link working}. */
  selected: boolean;
  /** A neighbour of the selection (#2523) — the softer ring. */
  related: boolean;
  /** The node the designer AI is touching (#2525) — pulses. Never set for the selected node. */
  working: boolean;
  /** Graph-health category (#2680), if any — the corner badge. */
  badge?: HealthCategory;
  /** The on-visit scan's outcome (#2838/#2908/#2926) — drives the build-error / empty-render glyphs. */
  buildStatus?: ComponentBuildStatus;
  onSelect: (c: ComponentRecord) => void;
}

export const ComponentNode = memo(function ComponentNode({
  c, x, y, selected, related, working, badge, buildStatus, onSelect,
}: ComponentNodeProps) {
  const state = selected ? " on" : related ? " related" : "";
  // Preview-error signal (#2838, #2908) — ADDITIVE to the health badge (different corner, own class).
  // The scan reports a `build` failure (esbuild) OR a `runtime` throw (#2908) — the tooltip names which.
  const buildError = buildStatus?.state === "error"
    ? `Preview ${buildStatus.kind} error — ${buildStatus.message}`
    : null;
  // Empty-render signal (#2926) — built + mounted clean but produced no visible output.
  const emptyRender = buildStatus?.state === "empty" ? buildStatus.message : null;
  return (
    <Box
      data-node
      onClick={() => onSelect(c)}
      className={`ds-node${state}${working ? " working" : ""}${badge ? " unhealthy" : ""}`}
      style={{ left: x, top: y, width: NODE_W }}
    >
      {badge && (
        <Text as="span" className={`ds-health ds-health-${badge}`} title={`${badge} — ${HEALTH_BADGE[badge].label}`}>{HEALTH_BADGE[badge].glyph}</Text>
      )}
      {buildError && (
        <Text as="span" className="ds-buildfail" title={buildError}>✖</Text>
      )}
      {emptyRender && (
        <Text as="span" className="ds-emptyrender" title={emptyRender}>▢</Text>
      )}
      <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, minWidth: 0 }}>
        {/* name truncates to ONE line (#3699) — a long name (GitHubCrossRepoActivity) must fit the
            fixed-width node, not wrap + overflow. Full name on hover via `title`. */}
        <RoleDot role={c.role} /><Text weight={600} size={13} title={c.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</Text>
      </Box>
      <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minWidth: 0 }}>
        {/* folder indicator (#3048) — the component's folder path, read inline on the existing role line.
            Truncates to one line (#3699); the ×used count is kept, never squeezed off. */}
        <Text size={10} tone="dim" title={c.folder ? `${c.role} · ${c.folder}` : c.role} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.role}{c.folder ? <Text as="span" tone="muted"> · {c.folder}</Text> : ""}</Text><Text mono size="xxs" tone="muted" style={{ flexShrink: 0, marginLeft: 6 }}>×{c.used}</Text>
      </Box>
    </Box>
  );
});
