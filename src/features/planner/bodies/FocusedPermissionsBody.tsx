// The focused Permissions stage (#817, split from FocusedBodies.tsx #1757): the fleet's streams as
// least-privilege agent rows (posture bar + per-stream editor), plus the coordination topology +
// director-drive controls and the "generate profiles" action that materializes the profiles the
// stage's `profilesComplete` gate requires.
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { AgentsA } from "@/features/planner/pane/agentEditor";
import { type Topology } from "@/features/planner/relationship/relationshipGraph";
import { DIRECTOR_DRIVES, type DirectorDrive } from "@/features/planner/fleet/directorDrive";
import type { FleetHandlers } from "./focusedHandlers";

/** The three coordination topologies + their one-line explainers (Permissions control). */
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

export function FocusedPermissionsBody({ data, onPerm, onPreset, onFlow, onModel, onGenerateProfiles, onTopology, onDirectorDrive, focusedStream, onSelectStream }: FleetHandlers & {
  data?: ProjectPaneData;
  /** #1392 streams-link: the graph-focused stream → expand its editor; report row open/close back. */
  focusedStream?: string;
  onSelectStream?: (id: string | null) => void;
}) {
  const agents = data?.agents ?? [];
  const topology = (data?.topology ?? "hybrid") as Topology;
  // The director is in play unless the topology is pure peer mesh.
  const hub = topology !== "peer";
  const drive = data?.director?.drive ?? "event";
  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◎</span>
        <span>No fleet yet — plan the work streams (fleet.json) first</span>
      </div>
    );
  }
  return (
    <div>
      {/* Coordination topology (#…): how agents relate — director-orchestrated, peer mesh,
          or hybrid. Reflected live in the Structure relationship graph. */}
      <div data-testid="topology-control" style={{
        padding: "9px 11px", marginBottom: 8, borderRadius: 8,
        background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
      }}>
        <span style={{ display: "block", fontFamily: "var(--mono)", fontWeight: 600, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".14em", color: "var(--fg-dim)", marginBottom: 9 }}>coordination</span>
        {/* full-width topology segmented (#1429 reskin) */}
        <div style={{ display: "flex", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", marginBottom: 1 }}>
          {TOPOLOGY_OPTS.map((t, i) => {
            const on = topology === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onTopology?.(t.id)}
                disabled={!onTopology}
                title={t.hint}
                style={{
                  flex: 1, padding: "7px 0", border: 0, borderLeft: i ? "1px solid var(--border)" : 0, cursor: onTopology ? "pointer" : "default",
                  fontFamily: "var(--mono)", fontWeight: 600, fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase",
                  background: on ? "var(--bg-elev2)" : "transparent",
                  color: on ? "var(--accent)" : "var(--fg-dim)",
                }}
              >{t.label}</button>
            );
          })}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
          {TOPOLOGY_OPTS.find((t) => t.id === topology)?.hint} · configure individual relationships on the Structure graph.
        </div>
        {/* Director drive — only when the topology routes through a director (#…). */}
        {hub && (
          <div data-testid="director-drive-control" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-soft)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)" }}>director drive</span>
            <div style={{ display: "flex", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
              {DIRECTOR_DRIVES.map((d) => (
                <button
                  key={d}
                  onClick={() => onDirectorDrive?.(d)}
                  disabled={!onDirectorDrive}
                  title={DRIVE_HINTS[d]}
                  style={{
                    height: 24, padding: "0 9px", border: 0, cursor: onDirectorDrive ? "pointer" : "default",
                    fontFamily: "var(--mono)", fontSize: 9.5,
                    background: drive === d ? "var(--bg-elev2)" : "transparent",
                    color: drive === d ? "var(--fg)" : "var(--fg-dim)",
                  }}
                >{d}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      {onGenerateProfiles && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "9px 11px", marginBottom: 8, borderRadius: 8,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        }}>
          <span style={{ flex: 1, minWidth: 160, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Each stream runs under a <strong style={{ color: "var(--fg)" }}>least-privilege profile</strong> —
            generate them, then review the posture per stream below.
          </span>
          <button className="mini accent" onClick={onGenerateProfiles} style={{ whiteSpace: "nowrap" }}>
            Generate least-privilege profiles
          </button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0 9px" }}>
        <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--fg-dim)" }}>permissions</span>
        <span style={{ fontFamily: "var(--mono)", fontWeight: 500, fontSize: 9, color: "var(--fg-dim)" }}>least-privilege · per stream</span>
      </div>
      <AgentsA agents={agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onModel={onModel} focusedStream={focusedStream} onSelect={onSelectStream} />
    </div>
  );
}
