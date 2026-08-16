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
import { memo, type CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { useAppStore } from "@/store";
import { ROLE_COLOR } from "./lib/model";
import { HEALTH_BADGE, worstHealth, type HealthCategory } from "./lib/graphHealth";
import { NODE_W } from "@/features/designs/lib/compositionLayout";
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
  /**
   * The STATIC graph-health category (#2680) — from `analyzeGraphHealth`, which changes only when the
   * library does. The scan's RUNTIME categories are NOT passed: this node reads its own
   * (#two-store-keys-drive-more-than-half-the-apps-jank), so a scan flush cannot re-render the parent.
   */
  badge?: HealthCategory;
  onSelect: (c: ComponentRecord) => void;
}

export const ComponentNode = memo(function ComponentNode({
  c, x, y, selected, related, working, badge: staticBadge, onSelect,
}: ComponentNodeProps) {
  // THE NODE READS ITS OWN SCAN SLICES (#two-store-keys-drive-more-than-half-the-apps-jank).
  //
  // These used to arrive as props, which meant `DesignsWorkbench` subscribed to the WHOLE
  // `componentBuildStatus` / `componentStateHealth` records — so every 150ms scan flush re-rendered the
  // workbench and rebuilt a health Map over every component, even though this node was already memoized
  // (#4132). Measured before: 3,296 designs commits at a 38.5ms median, 100% over a frame budget, and
  // 486 of 891 jank windows attributed to those two keys.
  //
  // Subscribing per node inverts it: a flush wakes only the nodes whose own entry changed. The batch
  // flush copies the record but keeps unchanged values by reference, so `Object.is` holds for every node
  // that did not move and their selectors do not re-render.
  const buildStatus = useAppStore((s) => s.componentBuildStatus[c.id]);
  const runtimeHealth = useAppStore((s) => s.componentStateHealth[c.id]);
  // Most-severe wins, by the same rule the workbench used to apply inline — now shared so the two
  // cannot drift (`worstHealth`).
  const badge = worstHealth(staticBadge, runtimeHealth);
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
      // `--ds-role` feeds the `::before` dot. A custom property is the only channel a pseudo-element
      // has, and it is what lets the dot stop being an element of its own.
      style={{ left: x, top: y, width: NODE_W, "--ds-role": ROLE_COLOR[c.role] } as CSSProperties}
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
      {/* Four leaves in one grid — see the `.ds-node` rules. The two flex wrappers they used to sit in
          did nothing but position them, which the grid now does without the elements or their
          per-render style objects. */}
      <Text className="ds-node-name" weight={600} size={13} title={c.name}>{c.name}</Text>
      <Text className="ds-node-role" size={10} tone="dim" title={c.folder ? `${c.role} · ${c.folder}` : c.role}>
        {c.role}{c.folder ? <Text as="span" tone="muted"> · {c.folder}</Text> : ""}
      </Text>
      <Text className="ds-node-used" mono size="xxs" tone="muted">×{c.used}</Text>
    </Box>
  );
});
