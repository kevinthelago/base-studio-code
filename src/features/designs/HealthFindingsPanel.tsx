// The graph-health WORKLIST (#3886) — what the toolbar's `⚠ N` badge opens.
//
// The findings already existed and already counted: `no-tests` (#3878) fires on 18 nodes in the packaged
// kit today, `no-analytics` on 18, `dangling-branch` on 22. But the badge was an inert `<Text>` and the
// only per-node signal was a glyph on the node itself — a needle across ~94 nodes on a zoomed-out canvas.
// A finding that fires and cannot be found is not a signal, so this turns the count into a list.
//
// Grouped by CATEGORY rather than listed flat: eighty findings in one column is a wall, and the useful
// unit of work is "the 18 untested nodes", not finding #47. Each row selects its node, which opens the
// inspector on it — where the Tests tab (#3884) shows the gap in detail. That is the whole loop:
// doctor → node → tab.
//
// Condensed-by-default is deliberate: the toolbar still shows only the icon + count until asked. The
// findings were condensed to exactly that on request, and this must not quietly re-expand them.
import { useMemo, useRef, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { HEALTH_BADGE, type HealthCategory, type HealthFinding } from "./lib/graphHealth";
import { groupFindings } from "./lib/healthGroups";

/** One row's label. A finding can name MANY nodes — a `dangling-branch` names its whole unreachable
 *  subtree — and spelling all of them out turns each row into a paragraph. Lead with the one the row
 *  selects and count the rest; the full list is in the row's `title`. */
function rowLabel(f: HealthFinding): string {
  const names = f.nodeNames.length ? f.nodeNames : f.nodeIds;
  return names.length > 1 ? `${names[0]} +${names.length - 1} more` : (names[0] ?? "");
}

/**
 * The `⚠ N` badge and the panel it toggles. `onSelectNode` receives a node id — the workbench selects it,
 * which opens the inspector. Renders nothing when there are no findings (a healthy graph shows no badge,
 * exactly as before).
 */
export function HealthFindingsPanel({ findings, onSelectNode }: {
  findings: HealthFinding[];
  onSelectNode: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Groups start COLLAPSED, so the panel opens as a scannable index — `dangling-branch 22 · no-analytics
  // 18 · no-tests 18 · …` — rather than a wall. Expanded-by-default was tried and is unusable: a single
  // `dangling-branch` finding names dozens of nodes, and those rows pushed every other category off the
  // first screen, which is precisely the thing this panel exists to prevent.
  const [expanded, setExpanded] = useState<HealthCategory | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  // `badgeRef` is the IGNORE ref: without it the dismissing outside-click also lands on the badge, whose
  // onClick then re-opens the panel — so it could never be closed by clicking the thing that opened it.
  useClickOutside(panelRef, () => setOpen(false), open, badgeRef);

  const groups = useMemo(() => groupFindings(findings), [findings]);
  if (findings.length === 0) return null;

  return (
    <Box style={{ position: "relative" }}>
      {/* eslint-disable-next-line no-restricted-syntax -- DOM ref (the outside-click ignore target); a
          token-styled count badge, not a .btn-family action */}
      <button
        ref={badgeRef}
        type="button"
        className="ds-healthcount"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`${findings.length} graph-health finding${findings.length === 1 ? "" : "s"} — the same set \`bsc ui doctor\` reports (#2680). Click for the list.`}
      >
        ⚠ {findings.length}
      </button>
      {open && (
        // eslint-disable-next-line no-restricted-syntax -- DOM ref for the outside-click dismissal
        <div ref={panelRef} className="ds-healthpanel" data-testid="ds-health-panel">
          {groups.map((g) => (
            <Box key={g.category} className="ds-healthgroup">
              <Box
                as="button"
                className="ds-healthgrouphead"
                aria-expanded={expanded === g.category}
                title={HEALTH_BADGE[g.category].label}
                onClick={() => setExpanded((e) => (e === g.category ? null : g.category))}
              >
                <Text as="span" className={`ds-health ds-health-${g.category}`}>{HEALTH_BADGE[g.category].glyph}</Text>
                <Text mono size={11} weight={600}>{g.category}</Text>
                <Box style={{ flex: 1 }} />
                <Text mono size={10.5} tone="dim">{g.findings.length}</Text>
              </Box>
              {expanded === g.category && (
                <>
                  <Text size={11} tone="muted" as="div" className="ds-healthgroupdesc">{HEALTH_BADGE[g.category].label}</Text>
                  {g.findings.map((f, i) => (
                    <Box
                      as="button"
                      key={`${f.category}-${f.nodeIds.join(",")}-${i}`}
                      className="ds-healthrow"
                      title={`${f.nodeNames.join(", ")}\n\n${f.why}`}
                      onClick={() => { onSelectNode(f.nodeIds[0]); setOpen(false); }}
                    >
                      <Text size={11.5} weight={600}>{rowLabel(f)}</Text>
                    </Box>
                  ))}
                </>
              )}
            </Box>
          ))}
        </div>
      )}
    </Box>
  );
}
