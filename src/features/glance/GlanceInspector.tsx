// Glance inspector (#2206) — the right dock, in one of two modes. PROJECT (node): status · role · cycle
// warning · depends-on / depended-on-by (clickable); clicking the project drills into its live agent
// network (L2, #2223/#2228). CONTRACT (edge): kind · cycle warning · consumer→provider · strength ·
// surface · description. Read-only view over the graph model.
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { StatTile } from "@/shared/ui/data/StatTile";
import { ROLE_COLOR, HEALTH_META, ACTIVITY_META, EDGE_META, isBandNode, bandNodeMeta, libIdOfNode, mcpIdOfNode, serviceIdOfNode, type GraphModel, type GNode, type GEdge } from "./lib/glanceGraph";
import { archetypeById, formById, hueColor } from "@/features/teams";

const FAULT_COLOR = "var(--graph-health-error)";

// Fills its (drag-resizable) wrapper column in GraphCanvas — the width is owned by the layout, not here.
const PANEL: React.CSSProperties = { flex: 1, minWidth: 0, background: "var(--bg-elev)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 15 };
const CARD: React.CSSProperties = { flex: 1, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" };
// The section micro-label, on the shared SectionLabel (#2420) with this inspector's tracking/rhythm.
const LABEL = (t: string) => <SectionLabel size={9.5} style={{ letterSpacing: "1px", margin: "20px 0 9px" }}>{t}</SectionLabel>;
const CYCLE_BG = "rgba(242,85,95,.08)", CYCLE_BD = "rgba(242,85,95,.28)";
// Iteration-loop (cyclical archetype, #2578) accents — violet, so a deliberate loop reads distinct from
// the red mutual-dependency hazard.
const LOOP_FG = "#c77dff", LOOP_TX = "#d9b3ff", LOOP_BG = "rgba(199,125,255,.08)", LOOP_BD = "rgba(199,125,255,.30)";

interface InspectorProps {
  model: GraphModel;
  selType: "node" | "edge" | null;
  selId: string | null;
  onSelectNode: (id: string) => void;
  onClose: () => void;
  /** When provided (the L1 project network, #2253), the CONTRACT view offers "remove link" — the edge is
   *  a user-drawn project relationship, so its `id` is the ProjectLink id. */
  onRemoveEdge?: (id: string) => void;
  /** The selected project's auto-triage toggle state (#2265). Undefined ⇒ don't render the control
   *  (a drilled fleet node, or an edge). */
  autoTriageOn?: boolean;
  /** Flip the selected project's auto-triage toggle (#2265). */
  onToggleAutoTriage?: (on: boolean) => void;
  /** Whether the selected node is currently OFF/deactivated (#3239). Undefined ⇒ don't render the
   *  activate/deactivate control (a drilled fleet node, or an edge). */
  offOn?: boolean;
  /** Turn the selected node off (deactivate, greyed) or back on (#3239). */
  onToggleOff?: (off: boolean) => void;
  /** Open the selected agent's REAL PTY stream in the dock (#2369). Provided only for a drilled, LIVE
   *  agent node — its presence is what renders the "Open stream" action. */
  onOpenStream?: (nodeId: string) => void;
  /** Resume the selected AGENT node's session (#glance-resume). Provided for a drilled fleet node: the
   *  workspace jumps to its Console pane when live, else relaunches that one agent. Its presence renders
   *  the node "Resume" action in this details pane. */
  onResumeNode?: (nodeId: string) => void;
  /** Whether the selected agent node has a live session (#glance-resume) — drives the resume action's
   *  wording (jump into an already-running pane vs relaunch a dormant one). */
  nodeLive?: boolean;
}

// Render a library-node blurb, wrapping `backtick`-delimited spans in <code> — so the ui kit's `bsc ui`
// keeps its inline-code styling (byte-identical to the pre-#3119 kit blurb) while algo/sound blurbs stay
// plain. #3119.
function blurbNodes(s: string): React.ReactNode[] {
  return s.split("`").map((seg, i) => (i % 2 ? <code key={i}>{seg}</code> : seg));
}

function DepRow({ node, kind, color, onClick }: { node: GNode; kind: string; color: string; onClick: () => void }) {
  return (
    <Row gap={9} align="center" onClick={onClick} style={{ padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 5 }}>
      <StatusDot color={ROLE_COLOR[node.role]} size={8} />
      <Text as="span" mono size={12} style={{ flex: 1 }}>{node.slug}</Text>
      <Text as="span" mono size={9.5} style={{ textTransform: "uppercase", letterSpacing: ".5px", color }}>{kind}</Text>
    </Row>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Row align="center" justify="between" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
      <Text as="span" mono size={10.5} tone="dim" style={{ letterSpacing: "1.5px" }}>{title}</Text>
      <IconButton aria-label="close inspector" onClick={onClose}>×</IconButton>
    </Row>
  );
}

export function GlanceInspector({ model, selType, selId, onSelectNode, onClose, onRemoveEdge, autoTriageOn, onToggleAutoTriage, offOn, onToggleOff, onOpenStream, onResumeNode, nodeLive }: InspectorProps) {
  if (selType === "node" && selId) {
    const n = model.nodes.find((x) => x.id === selId);
    if (!n) return null;

    // A fenced-BAND node — a cross-graph LIBRARY node (#2571 kit → #3119) OR an external CONTRACT node
    // (#3786: an `mcp` server or a `service`): the node id + the projects that CONSUME it (the edges into
    // it), each clickable to hop to that project. A band node has no health/activity/role of its own, so
    // the project tiles are replaced by a scoped panel. The `ui` case is byte-identical to the pre-#3119
    // kit panel (header "UI KIT" · ◆ · "ui kit" · "uses kit"); an mcp/service node reads its panel title ·
    // glyph · appType · "contracts with".
    if (isBandNode(n)) {
      const lib = bandNodeMeta(n);
      const consumers = model.edges.filter((e) => e.to === n.id);
      return (
        <Box style={PANEL}>
          <Header title={lib.panelTitle} onClose={onClose} />
          <Box style={{ flex: 1, overflowY: "auto", padding: "18px 16px" }}>
            <Text as="div" mono size={19} weight={700} style={{ letterSpacing: "-.4px" }}>{n.slug}</Text>
            {/* The node id — plus, for an external contract node (mcp/service), its appType (#3786): the
                contract endpoint type. Library/kit nodes carry no appType. */}
            <Text as="div" mono size={11} tone="dim" style={{ marginTop: 4 }}>
              {n.kind === "mcp" ? mcpIdOfNode(n.id) : n.kind === "service" ? serviceIdOfNode(n.id) : libIdOfNode(n.id)}{n.appType ? ` · ${n.appType}` : ""}
            </Text>

            <Grid cols={2} gap={8} style={{ marginTop: 16 }}>
              <StatTile k="KIND" v={
                <Row gap={7} align="center">
                  <Text as="span" style={{ color: lib.color, flex: "none" }}>{lib.marker}</Text>
                  <Text as="span" mono size={12.5} weight={500} style={{ color: lib.color }}>{lib.panelTitle.toLowerCase()}</Text>
                </Row>
              } />
              <StatTile k="CONSUMERS" v={
                <Text as="span" mono size={12.5} weight={500} tone="muted">{consumers.length} project{consumers.length === 1 ? "" : "s"}</Text>
              } />
            </Grid>

            <Row gap={9} align="start" style={{ marginTop: 14, background: `color-mix(in oklch, ${lib.color} 8%, transparent)`, border: `1px solid color-mix(in oklch, ${lib.color} 30%, transparent)`, borderRadius: 8, padding: "10px 12px" }}>
              <Text as="span" style={{ color: lib.color, flex: "none" }}>{lib.marker}</Text>
              <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: "var(--fg-muted)" }}>{blurbNodes(lib.blurb)}</Text>
            </Row>

            {LABEL("CONSUMED BY")}
            {consumers.length === 0 ? <Text as="div" mono size={11} tone="dim">— no consumers</Text>
              : consumers.map((e) => {
                  const consumer = model.nodes.find((x) => x.id === e.from);
                  return consumer ? <DepRow key={e.id} node={consumer} kind={lib.edgeLabel} color={lib.color} onClick={() => onSelectNode(e.from)} /> : null;
                })}
          </Box>
        </Box>
      );
    }

    const health = HEALTH_META[n.rollupHealth];   // axis 1 — rolled-up health (dot colour)
    const activity = ACTIVITY_META[n.activity];   // axis 2 — the lifecycle word
    const faults = n.faults ?? 0;
    const deps = model.edges.filter((e) => e.from === n.id);
    const rdeps = model.edges.filter((e) => e.to === n.id);
    const inCycle = model.cycleNodeIds.has(n.id);
    // A deliberate iteration LOOP (all this node's cycle edges cyclical, #2578) vs a mutual-dependency
    // HAZARD — the note is positive (a converging feedback loop) rather than a deadlock warning.
    const cycleLoop = inCycle && !model.edges.some((e) => e.isCycle && (e.from === n.id || e.to === n.id) && !archetypeById(e.archetype ?? "")?.cyclical);
    // An L1 (fleet) edge labels + colours by its Org archetype (Manages/Oversees/Peers…); an L0 edge by kind.
    const kindOf = (e: GEdge) => (e.isCycle ? "cycle" : e.archetype ? (archetypeById(e.archetype)?.label ?? e.archetype) : EDGE_META[e.kind].label.split(" ")[0]);
    const colorOf = (e: GEdge) => (e.isCycle ? "var(--graph-health-error)" : e.archetype ? hueColor(archetypeById(e.archetype)?.hue ?? 0) : EDGE_META[e.kind].color);

    return (
      <Box style={PANEL}>
        <Header title="PROJECT" onClose={onClose} />
        <Box style={{ flex: 1, overflowY: "auto", padding: "18px 16px" }}>
          <Text as="div" mono size={19} weight={700} style={{ letterSpacing: "-.4px" }}>{n.slug}</Text>

          {/* HEALTH (axis 1) / ACTIVITY (axis 2) / ROLE as shared metric tiles (#2420/#2541). The health
              value is the ROLLED-UP health; an inherited (downstream) health is flagged so the user
              knows the cause is a dependency, not this node. */}
          <Grid cols={2} gap={8} style={{ marginTop: 16 }}>
            <StatTile k="HEALTH" v={
              <Row gap={7} align="center">
                <StatusDot color={health.color} size={9} style={{ boxShadow: health.pulse ? `0 0 8px ${health.color}` : "none" }} />
                <Text as="span" mono size={12.5} weight={500} style={{ color: health.color }}>{n.rollupHealth}{n.healthInherited ? " · downstream" : ""}</Text>
              </Row>
            } />
            <StatTile k="ACTIVITY" v={
              <Text as="span" mono size={12.5} weight={500} tone="muted">{activity.label}</Text>
            } />
          </Grid>
          <Grid cols={2} gap={8} style={{ marginTop: 8 }}>
            <StatTile k="ROLE" v={
              <Text as="span" mono size={11} style={{ color: ROLE_COLOR[n.role], background: `color-mix(in oklch, ${ROLE_COLOR[n.role]} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${ROLE_COLOR[n.role]} 30%, transparent)`, borderRadius: 5, padding: "3px 8px" }}>{n.roleLabel ?? n.role}</Text>
            } />
            {n.reason
              ? <StatTile k="REASON" v={<Text as="span" mono size={11} style={{ color: health.color, lineHeight: 1.4 }}>{n.reason}</Text>} />
              : <Box />}
          </Grid>

          {/* PROGRESS (#4118) — the focused worker's owned-issue completion, the same counts its node
              draws. The node's bar is a glance; this is where the user comes for the number, so it
              carries `done/total` plus the remaining count rather than a bare fill.
              Absent when the stream owns no issues — the same rule the node follows: a bar for a node
              with no work would state something false. */}
          {n.progress && n.progress.total > 0 && (
            <Box style={{ marginTop: 8 }}>
              <StatTile k="PROGRESS" v={
                <Box>
                  <Row gap={8} align="baseline">
                    <Text as="span" mono size={12.5} weight={600} style={{ color: "var(--graph-health-complete)" }}>
                      {n.progress.done}/{n.progress.total}
                    </Text>
                    <Text as="span" mono size={11} tone="muted">
                      {n.progress.done === n.progress.total
                        ? "every owned issue closed"
                        : `${n.progress.total - n.progress.done} open`}
                    </Text>
                  </Row>
                  <Box aria-hidden style={{ marginTop: 6, height: 5, borderRadius: 3, overflow: "hidden",
                    background: "color-mix(in oklch, var(--fg-muted) 26%, transparent)" }}>
                    <Box style={{ width: `${(n.progress.done / n.progress.total) * 100}%`, height: "100%",
                      borderRadius: 3, background: "var(--graph-health-complete)", transition: "width .3s ease" }} />
                  </Box>
                </Box>
              } />
            </Box>
          )}

          {/* Activate / deactivate this node (#3239): the manual OFF toggle. Turning it off greys the node
              on the network (health `off`) over any live status; turning it on restores its derived status.
              Persisted, so it continues from the last session. Only on the L0 project network (onToggleOff
              supplied) — a drilled fleet node has none. */}
          {onToggleOff && (
            <Box style={{ marginTop: 14, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: "11px 12px" }}>
              <Row justify="between" align="center" gap={10}>
                <Box style={{ minWidth: 0 }}>
                  <Text as="div" mono size={12} weight={600} style={{ color: offOn ? "var(--graph-health-off)" : "var(--fg)" }}>
                    {offOn ? "Node is off" : "Node is active"}
                  </Text>
                  <Text as="div" size={10.5} tone="dim" style={{ lineHeight: 1.4, marginTop: 2 }}>
                    {offOn ? "greyed on the graph — deactivated" : "shown with its live status"}
                  </Text>
                </Box>
                <Button variant={offOn ? "primary" : "ghost"} onClick={() => onToggleOff(!offOn)}
                  aria-label={offOn ? "turn node on" : "turn node off"} style={{ flex: "none" }}>
                  {offOn ? "Turn on" : "Turn off"}
                </Button>
              </Row>
            </Box>
          )}

          {inCycle && (cycleLoop
            ? <Row gap={9} align="start" style={{ marginTop: 14, background: LOOP_BG, border: `1px solid ${LOOP_BD}`, borderRadius: 8, padding: "10px 12px" }}>
                <Text as="span" style={{ color: LOOP_FG, flex: "none" }}>⟳</Text>
                <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: LOOP_TX }}>In a deliberate iteration loop — cycles with its counterpart (findings ⟳ revisions) until it converges. Not a hazard.</Text>
              </Row>
            : <Row gap={9} align="start" style={{ marginTop: 14, background: CYCLE_BG, border: `1px solid ${CYCLE_BD}`, borderRadius: 8, padding: "10px 12px" }}>
                <Text as="span" style={{ color: "var(--graph-health-error)", flex: "none" }}>▲</Text>
                <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: "var(--cycle-soft)" }}>In a cross-project dependency cycle — coordinate release order before shipping to avoid a deadlock.</Text>
              </Row>
          )}

          {/* PERSONA (#2561): the agent identity at this fleet node — who is at the terminal (name · model ·
              skills · charter), the "quick means" to see the assigned persona alongside its role. */}
          {n.persona && (
            <>
              {LABEL("PERSONA")}
              <Box style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: "11px 12px" }}>
                <Row justify="between" align="center">
                  <Text as="span" mono size={13} weight={600}>{n.persona.name}</Text>
                  {n.persona.model && <Text as="span" mono size={10} tone="dim">{n.persona.model}</Text>}
                </Row>
                <Text as="div" size={10.5} tone="dim" style={{ marginTop: 3 }}>
                  role {n.persona.role} · {n.persona.skills.length} skill{n.persona.skills.length === 1 ? "" : "s"}
                </Text>
                {n.persona.responsibilities.length > 0 && (
                  <Box style={{ marginTop: 8 }}>
                    {n.persona.responsibilities.map((r, i) => (
                      <Text key={i} as="div" size={11} tone="muted" style={{ lineHeight: 1.5 }}>• {r}</Text>
                    ))}
                  </Box>
                )}
              </Box>
            </>
          )}

          {/* COMMUNICATION SURFACE (#2563): who this agent talks to and how — one card per relationship
              from the fleet-as-Org projection, with the forms it SENDS (→) / RECEIVES (←) + transports. */}
          {n.persona?.comms && n.persona.comms.length > 0 && (
            <>
              {LABEL("COMMUNICATION")}
              <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {n.persona.comms.map((c, i) => (
                  <Box key={i} style={{ background: "var(--bg-soft)", border: `1px solid color-mix(in oklch, ${hueColor(c.hue)} 30%, transparent)`, borderRadius: 8, padding: "9px 11px" }}>
                    <Row justify="between" align="center">
                      <Text as="span" mono size={11.5} weight={600}>{c.withName}</Text>
                      <Text as="span" mono size={9.5} style={{ color: hueColor(c.hue), textTransform: "uppercase", letterSpacing: ".5px" }}>{c.archetypeLabel}</Text>
                    </Row>
                    {([["→", c.sends], ["←", c.receives]] as const).map(([dir, forms]) => forms.length > 0 && (
                      <Row key={dir} gap={6} align="baseline" style={{ marginTop: 5 }}>
                        <Text as="span" mono size={10} tone="dim" style={{ width: 12, flex: "none" }}>{dir}</Text>
                        <Text as="span" mono size={10} tone="muted" style={{ lineHeight: 1.5 }}>
                          {forms.map((f) => f.label + (f.transport ? ` (${f.transport})` : "")).join(" · ")}
                        </Text>
                      </Row>
                    ))}
                  </Box>
                ))}
              </Box>
            </>
          )}

          {/* FAULT-health (#2265): unresolved runtime faults + the per-project auto-triage toggle. Only
              shown on the project network (onToggleAutoTriage supplied) — a drilled fleet node has neither. */}
          {onToggleAutoTriage && (
            <>
              {LABEL("RUNTIME FAULTS")}
              <Box style={{ background: faults > 0 ? "rgba(242,85,95,.08)" : "var(--bg-soft)", border: `1px solid ${faults > 0 ? "rgba(242,85,95,.28)" : "var(--border)"}`, borderRadius: 8, padding: "11px 12px" }}>
                <Row gap={9} align="center">
                  {faults > 0
                    ? <Text as="span" style={{ color: FAULT_COLOR, flex: "none" }}>●</Text>
                    : <Text as="span" tone="dim" style={{ flex: "none" }}>○</Text>}
                  <Text as="span" mono size={13} weight={600} style={{ color: faults > 0 ? "var(--cycle-soft)" : "var(--fg-muted)" }}>
                    {faults > 0 ? `${faults} unresolved` : "no open faults"}
                  </Text>
                </Row>
                <Row justify="between" align="center" style={{ marginTop: 11 }}>
                  <Box style={{ minWidth: 0 }}>
                    <Text as="div" mono size={11} weight={500}>auto-triage</Text>
                    <Text as="div" size={10.5} tone="dim" style={{ lineHeight: 1.4, marginTop: 2 }}>
                      {autoTriageOn ? "routes a fix into the director" : "surface-only — no auto-dispatch"}
                    </Text>
                  </Box>
                  <Toggle on={!!autoTriageOn} size="sm" onClick={() => onToggleAutoTriage(!autoTriageOn)} role="switch" ariaChecked={!!autoTriageOn} />
                </Row>
              </Box>
            </>
          )}

          {LABEL("AGENTS")}
          <Text as="div" size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>Click this project to drill into its live agent network (director · workers · triage).</Text>

          {LABEL(n.persona ? "RELATES TO" : "DEPENDS ON")}
          {deps.length === 0 ? <Text as="div" mono size={11} tone="dim">— foundational, no upstream deps</Text>
            : deps.map((e) => <DepRow key={e.id} node={model.nodes.find((x) => x.id === e.to)!} kind={kindOf(e)} color={colorOf(e)} onClick={() => onSelectNode(e.to)} />)}

          {LABEL(n.persona ? "RELATED FROM" : "DEPENDED ON BY")}
          {rdeps.length === 0 ? <Text as="div" mono size={11} tone="dim">— leaf, nothing depends on it</Text>
            : rdeps.map((e) => <DepRow key={e.id} node={model.nodes.find((x) => x.id === e.from)!} kind={kindOf(e)} color={colorOf(e)} onClick={() => onSelectNode(e.from)} />)}

          {/* Open the agent's REAL live PTY stream in the dock (#2369) — only for a live drilled agent. */}
          {/* Resume this AGENT's session (#glance-resume) — jumps to its Console pane when live, else
              relaunches that one agent (claude --continue). Primary action for a drilled fleet node. */}
          {onResumeNode && (
            <Button variant="primary" onClick={() => onResumeNode(selId)} style={{ width: "100%", marginTop: 18 }}>
              {nodeLive ? "Open session ↗" : "▶ Resume session"}
            </Button>
          )}
          {/* Peek the agent's REAL live PTY stream inline in the graph (#2369) — only for a live drilled agent. */}
          {onOpenStream && (
            <Button variant={onResumeNode ? "ghost" : "primary"} onClick={() => onOpenStream(selId)} style={{ width: "100%", marginTop: onResumeNode ? 8 : 18 }}>Open stream ↗</Button>
          )}
        </Box>
      </Box>
    );
  }

  if (selType === "edge" && selId) {
    const e = model.edges.find((x) => x.id === selId);
    if (!e) return null;
    const meta = EDGE_META[e.kind];
    // A fleet-drill (L1) edge is an Org RELATIONSHIP (archetype → communication forms); an L0 edge is a
    // project contract. Resolve the archetype so the chip/colour/forms speak the org grammar (#2561).
    const arch = e.archetype ? archetypeById(e.archetype) : undefined;
    // A cyclical archetype (iterates, #2578) is a deliberate LOOP — keep the archetype label + hue, not
    // the red "cycle" hazard chip.
    const loop = e.isCycle && !!arch?.cyclical;
    const kindColor = loop ? hueColor(arch!.hue) : e.isCycle ? "var(--graph-health-error)" : arch ? hueColor(arch.hue) : meta.color;
    const chipLabel = loop ? arch!.label : e.isCycle ? "cycle" : arch ? arch.label : meta.label;
    const from = model.nodes.find((x) => x.id === e.from)!, to = model.nodes.find((x) => x.id === e.to)!;
    return (
      <Box style={PANEL}>
        <Header title={arch ? "RELATIONSHIP" : "CONTRACT INSPECTOR"} onClose={onClose} />
        <Box style={{ flex: 1, overflowY: "auto", padding: "18px 16px" }}>
          <Text as="span" mono size={11} style={{ color: loop ? kindColor : e.isCycle ? "var(--cycle)" : kindColor, background: `color-mix(in oklch, ${kindColor} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${kindColor} 32%, transparent)`, borderRadius: 6, padding: "5px 10px" }}>{chipLabel}</Text>

          {loop && (
            <Row gap={9} align="start" style={{ marginTop: 14, background: LOOP_BG, border: `1px solid ${LOOP_BD}`, borderRadius: 8, padding: "11px 12px" }}>
              <Text as="span" style={{ color: LOOP_FG, flex: "none" }}>⟳</Text>
              <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: LOOP_TX }}>An iteration loop — {from.slug} and {to.slug} cycle deliberately (findings ⟳ revisions) until it converges. Not a dependency hazard.</Text>
            </Row>
          )}
          {e.isCycle && !loop && (
            <Row gap={9} align="start" style={{ marginTop: 14, background: CYCLE_BG, border: `1px solid ${CYCLE_BD}`, borderRadius: 8, padding: "11px 12px" }}>
              <Text as="span" style={{ color: "var(--graph-health-error)", flex: "none" }}>▲</Text>
              <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: "var(--cycle-soft)" }}>This edge closes a cycle. Two projects depend on each other — releasing either in isolation can deadlock the other.</Text>
            </Row>
          )}

          <Row gap={12} align="center" style={{ marginTop: 20 }}>
            <Box onClick={() => onSelectNode(e.from)} style={{ ...CARD, cursor: "pointer" }}>
              <Text as="div" mono size={9} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>CONSUMER</Text>
              <Row gap={7} align="center"><StatusDot color={ROLE_COLOR[from.role]} size={8} /><Text as="span" mono size={12}>{from.slug}</Text></Row>
            </Box>
            <Text as="span" tone="dim">→</Text>
            <Box onClick={() => onSelectNode(e.to)} style={{ ...CARD, cursor: "pointer" }}>
              <Text as="div" mono size={9} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>PROVIDER</Text>
              <Row gap={7} align="center"><StatusDot color={ROLE_COLOR[to.role]} size={8} /><Text as="span" mono size={12}>{to.slug}</Text></Row>
            </Box>
          </Row>

          <Box style={{ ...CARD, marginTop: 16, flex: "unset" }}>
            <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>STRENGTH</Text>
            <Text as="span" mono size={11} style={{ color: e.hard ? "var(--graph-health-warning)" : "var(--fg-muted)" }}>{e.hard ? "hard" : "soft"}</Text>
          </Box>

          {arch ? (
            <>
              {/* The Org communication FORMS this archetype expands into (#2561) — what flows each way and
                  the `bsc-*` transport that carries it at runtime. */}
              {LABEL("COMMUNICATION")}
              <Box style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px" }}>
                {[...arch.forward.map((id) => ({ id, dir: "→" })), ...arch.backward.map((id) => ({ id, dir: "←" }))].map(({ id, dir }, i) => {
                  const f = formById(id);
                  if (!f) return null;
                  return (
                    <Row key={`${id}-${i}`} gap={8} align="center" style={{ padding: "5px 0" }}>
                      <Text as="span" mono size={11} tone="dim" style={{ width: 12 }}>{dir}</Text>
                      <Text as="span" mono size={11.5} weight={500} style={{ flex: 1 }}>{f.label}</Text>
                      {f.transport && <Text as="span" mono size={10} style={{ color: kindColor }}>{f.transport}</Text>}
                    </Row>
                  );
                })}
              </Box>

              {LABEL("DESCRIPTION")}
              <Text as="div" size={12} style={{ lineHeight: 1.6, color: "var(--fg-muted)" }}>{arch.blurb}</Text>
            </>
          ) : (
            <>
              {LABEL("SURFACE")}
              <Box style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 13px" }}>
                <Text as="span" mono size={11.5} tone="muted" style={{ lineHeight: 1.7 }}>{meta.surface}</Text>
              </Box>

              {LABEL("DESCRIPTION")}
              <Text as="div" size={12} style={{ lineHeight: 1.6, color: "var(--fg-muted)" }}>
                {e.isCycle
                  ? `${from.slug} and ${to.slug} depend on each other. This back-edge closes the loop — treat as a release-ordering hazard.`
                  : `${from.slug} consumes ${to.slug} over a ${meta.label.toLowerCase()}. ${e.hard ? "Hard dependency: a breaking change here blocks the consumer." : "Soft dependency: degrades gracefully."}`}
              </Text>
            </>
          )}

          {onRemoveEdge && (
            <Box style={{ marginTop: 22 }}>
              <Button variant="ghost" onClick={() => { onRemoveEdge(e.id); onClose(); }}>✕ remove link</Button>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  return null;
}
