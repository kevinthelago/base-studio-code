// TransformationsBody — right-pane body for the "transformations" planning stage (#2509): the
// BOTTOM-UP CONFIRM QUEUE (the settled presentation model). Rows group by composition tier
// (Tier 0 · primitives → … → pages); only the CURRENT tier (the lowest with pending work) is
// actionable — higher tiers render collapsed/locked until it's confirmed, so composites are
// generated against confirmed primitives and nothing is built on unreviewed foundations. An item
// is pending or confirmed, NOTHING ELSE: the one action is Confirm (no reject/exclude — changes
// are described conversationally to the planner and the item re-presents). When a row carries a
// KitNode `spec` it renders live through the #1852 KitRenderer (defensively — a bad spec falls
// back to a "spec present" chip, never a pane crash). Once every row is confirmed the final
// synthetic "Completed UI" card shows; signing it off is the NORMAL stage confirm in the footer.

import { Component, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { bscRun } from "@/shared/lib/core/bsc";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { KitRenderer, validateKitNode, type KitNode } from "@/shared/ui/spec";
import { Card } from "./bodyPrimitives";
import {
  tierGroups, nextPendingTier, tierLabel, specNodeCount, verbMeta, type TransformationRow,
} from "../lib/transformations";

const EMPTY_ROWS: TransformationRow[] = [];

/** Error boundary around the live spec render: a spec that VALIDATES but still crashes at render
 *  time (renderer/spec drift) degrades to the fallback chip instead of taking down the pane. */
class SpecBoundary extends Component<{ fallback: ReactNode; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The live component preview: validate first (the same contract `bsc ui validate` enforces),
 *  render through KitRenderer inside the boundary, and fall back to a "spec present (n nodes)"
 *  chip on ANY failure. Read-only — no bindings are wired (the planner owns edits, #2382). */
function SpecPreview({ id, spec }: { id: string; spec: object }) {
  const fallback = (
    <Box data-testid={`transformation-spec-fallback-${id}`} style={{ alignSelf: "flex-start" }}>
      <Chip tone="neutral" size="xs">spec present ({specNodeCount(spec)} nodes)</Chip>
    </Box>
  );
  if (validateKitNode(spec).length > 0) return fallback;
  return (
    <SpecBoundary fallback={fallback}>
      <Box data-testid={`transformation-spec-${id}`} pad={[8, 8]} bg="var(--bg-canvas)" border="soft" radius={6}>
        <KitRenderer node={spec as KitNode} />
      </Box>
    </SpecBoundary>
  );
}

/** One queue item: verb + title, provenance, target, delta, invariants, owns, live preview, and —
 *  when it's pending in the CURRENT tier — the single Confirm action. */
function TransformationItem({ row, actionable, onConfirm }: {
  row: TransformationRow;
  actionable: boolean;
  onConfirm: (id: string) => void;
}) {
  const evidence = row.provenance?.evidence ?? [];
  const recipe = row.provenance?.recipe;
  const confirmed = row.confirmed === true;
  return (
    <Box
      data-testid={`transformation-${row.id}`}
      pad={[8, 10]} bg="var(--bg-canvas)" border="soft" radius={6}
    >
      <Stack gap={5}>
        <Row gap={7}>
          {/* The taxonomy blurb rides as the tooltip (#2509 slice b — verb metadata is @data). */}
          <Chip tone="accent" size="xs" title={verbMeta(row.verb).blurb}>{row.verb}</Chip>
          <Text as="span" size={12} weight={600} style={{ color: "var(--fg)" }}>{row.title}</Text>
          <Spacer />
          {confirmed ? (
            <Chip tone="success" size="xs" dot>confirmed</Chip>
          ) : actionable ? (
            <Button
              size="sm" variant="primary"
              data-testid={`transformation-confirm-${row.id}`}
              onClick={() => onConfirm(row.id)}
            >
              Confirm
            </Button>
          ) : (
            <Chip tone="neutral" size="xs">pending</Chip>
          )}
        </Row>
        {(recipe || evidence.length > 0 || row.kitContribution) && (
          <Row gap={6}>
            <Text as="span" mono size={9.5} tone="dim" title={evidence.join("\n")}>
              {recipe ? `recipe: ${recipe}` : "ad hoc"}
              {evidence.length > 0 ? ` · ${evidence.length} evidence` : ""}
            </Text>
            {row.kitContribution && <Chip tone="info" size="xs">kit contribution</Chip>}
          </Row>
        )}
        <Text as="div" size={11} tone="muted" style={{ lineHeight: 1.5 }} title={(row.target.files ?? []).join("\n")}>
          {row.target.description}
        </Text>
        <Text as="div" mono size={10.5} style={{ color: "var(--fg)", lineHeight: 1.5 }}>
          Δ {row.delta}
        </Text>
        {row.invariants.length > 0 && (
          <Stack gap={2}>
            {row.invariants.map((inv, i) => (
              <Row key={i} gap={6}>
                <Text as="span" mono size={9.5} tone="dim" style={{ width: 10, flex: "0 0 auto" }}>⛨</Text>
                <Text as="span" mono size={9.5} tone="muted">{inv}</Text>
              </Row>
            ))}
          </Stack>
        )}
        {row.owns.length > 0 && (
          <Text
            as="div" mono size={9.5} tone="dim" title={row.owns.join("\n")}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            owns {row.owns.join(" · ")}
          </Text>
        )}
        {row.spec && <SpecPreview id={row.id} spec={row.spec} />}
      </Stack>
    </Box>
  );
}

export function TransformationsBody({ projectId }: { projectId?: string }) {
  const pid = projectId ?? "";
  const rows = useAppStore((s) => s.planTransformations[pid]) ?? EMPTY_ROWS;
  const setPlanTransformations = useAppStore((s) => s.setPlanTransformations);

  if (rows.length === 0) {
    return (
      <EmptyState
        iconVariant="dashed" icon="⇄" title="No transformations yet"
        description="The planner decomposes the modification request via bsc plan transformation add."
      />
    );
  }

  const groups = tierGroups(rows);
  const pendingTier = nextPendingTier(rows);
  const allConfirmed = pendingTier === null;
  const maxTier = groups[groups.length - 1].tier;

  // The ONE action (#2509): confirm — durable via the bsc bridge, optimistic locally (the poll's
  // change-guard preserves the flip until plan.db reflects it).
  const onConfirm = (id: string) => {
    void bscRun(pid, ["plan", "transformation", "confirm", id]);
    setPlanTransformations(pid, rows.map((r) => (r.id === id ? { ...r, confirmed: true } : r)));
  };

  return (
    <Stack gap={8}>
      {groups.map((g) => {
        const locked = pendingTier !== null && g.tier > pendingTier;
        const confirmedCount = g.rows.filter((r) => r.confirmed === true).length;
        return (
          <Box key={g.tier} data-testid={`transformation-tier-${g.tier}`}>
            <Card
              label={tierLabel(g.tier, maxTier)}
              hint={locked ? `confirm tier ${pendingTier} first` : `${confirmedCount}/${g.rows.length} confirmed`}
              accent={g.tier === pendingTier}
            >
              {locked ? (
                // Locked tier: collapsed — its items are generated against the tier below, so they
                // aren't reviewable until that foundation is confirmed.
                <Text as="div" mono size={10} tone="dim">
                  {g.rows.length} item{g.rows.length === 1 ? "" : "s"} · locked
                </Text>
              ) : (
                <Stack gap={6}>
                  {g.rows.map((row) => (
                    <TransformationItem
                      key={row.id} row={row}
                      actionable={g.tier === pendingTier}
                      onConfirm={onConfirm}
                    />
                  ))}
                </Stack>
              )}
            </Card>
          </Box>
        );
      })}

      {/* The final synthetic item: the assembled UI. Shown once every row is confirmed; signing it
          off is the NORMAL stage confirm (the footer's approve & continue) — no extra machinery. */}
      {allConfirmed && (
        <Box data-testid="transformations-complete">
          <Card label="Completed UI" accent>
            <Text as="div" size={11} tone="muted" style={{ lineHeight: 1.55 }}>
              Every tier is confirmed — the assembled UI (pages composed on the confirmed
              foundations) is ready. Approve the stage to sign off the completed UI.
            </Text>
          </Card>
        </Box>
      )}

      <Text as="div" mono size={9.5} tone="dim" style={{ lineHeight: 1.5 }}>
        Want changes? Describe them to the planner — the item re-presents.
      </Text>
    </Stack>
  );
}
