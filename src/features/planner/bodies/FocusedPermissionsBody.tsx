// Coordination controls (#817, split from FocusedBodies.tsx #1757; the per-stream roster was hoisted
// to StreamsBody #…): the fleet-WIDE coordination topology (director / peer / hybrid) + the
// director-drive mode. The per-stream agent rows now live directly in StreamsBody (AgentsA), so this
// file owns ONLY the fleet-scoped controls, rendered inside a collapsible "Coordination" card. Every
// stream still auto-runs under its ROLE's profile (worker → Autonomous, director → Read-only review).
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { type Topology } from "@/features/planner/relationship/relationshipGraph";
import { DIRECTOR_DRIVES, type DirectorDrive } from "@/features/planner/fleet/directorDrive";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Row } from "@/shared/ui/layout/Row";
import type { FleetHandlers } from "./focusedHandlers";

/** The three coordination topologies + their one-line explainers. */
const TOPOLOGY_OPTS: { id: Topology; label: string; hint: string }[] = [
  { id: "director", label: "Director", hint: "hub-and-spoke — every relationship routes through the director" },
  { id: "peer",     label: "Peer",     hint: "mesh — agents hand off directly to each other" },
  { id: "hybrid",   label: "Hybrid",   hint: "per-edge — director for some, direct for others" },
];

/** Director drive modes (when a director is in play) + their tooltips. */
const DRIVE_HINTS: Record<DirectorDrive, string> = {
  event:     "re-prompt the director when workers post coordination events (idle-gated)",
  heartbeat: "re-prompt on a fixed interval — a periodic fleet sweep",
  manual:    "never auto-prompt — poke it from the Coordination inbox",
  off:       "the director is never driven (a static session)",
};

/** The fleet-wide coordination controls — topology + director drive. Rendered as the body of the
 *  collapsible "Coordination" card in StreamsBody (no outer frame of its own). */
export function CoordinationControls({ data, onTopology, onDirectorDrive }: Pick<FleetHandlers, "onTopology" | "onDirectorDrive"> & {
  data?: ProjectPaneData;
}) {
  const topology = (data?.topology ?? "hybrid") as Topology;
  // The director is in play unless the topology is pure peer mesh.
  const hub = topology !== "peer";
  const drive = data?.director?.drive ?? "event";
  return (
    <Box>
      {/* full-width topology segmented */}
      <Row data-testid="topology-control" align="stretch" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", marginBottom: 6 }}>
        {TOPOLOGY_OPTS.map((t, i) => {
          const on = topology === t.id;
          return (
            // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled full-width segmented cell; Button/.btn would change rendering
            <button
              key={t.id}
              onClick={() => onTopology?.(t.id)}
              disabled={!onTopology}
              title={t.hint}
              className="mono"
              style={{
                flex: 1, padding: "7px 0", border: 0, borderLeft: i ? "1px solid var(--border)" : 0, cursor: onTopology ? "pointer" : "default",
                fontWeight: 600, fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase",
                background: on ? "var(--bg-elev2)" : "transparent",
                color: on ? "var(--accent)" : "var(--fg-dim)",
              }}
            >{t.label}</button>
          );
        })}
      </Row>
      <Text as="div" mono size={9.5} tone="dim" style={{ lineHeight: 1.5 }}>
        {TOPOLOGY_OPTS.find((t) => t.id === topology)?.hint} · configure individual relationships on the graph above.
      </Text>
      {/* Director drive — only when the topology routes through a director. */}
      {hub && (
        <Row data-testid="director-drive-control" gap={8} style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-soft)" }}>
          <Text as="span" mono size={9.5} tone="muted">director drive</Text>
          <Row align="stretch" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
            {DIRECTOR_DRIVES.map((d) => (
              // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled segmented cell; Button/.btn would change rendering
              <button
                key={d}
                onClick={() => onDirectorDrive?.(d)}
                disabled={!onDirectorDrive}
                title={DRIVE_HINTS[d]}
                className="mono"
                style={{
                  height: 24, padding: "0 9px", border: 0, cursor: onDirectorDrive ? "pointer" : "default",
                  fontSize: 9.5,
                  background: drive === d ? "var(--bg-elev2)" : "transparent",
                  color: drive === d ? "var(--fg)" : "var(--fg-dim)",
                }}
              >{d}</button>
            ))}
          </Row>
        </Row>
      )}
    </Box>
  );
}
