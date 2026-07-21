// Blueprint Author — TEAM (#2450). The blueprint's own org configuration, authored in two steps:
// 1 · ARCHETYPE PICKER — fork a library org (or start blank) into `bp.team` (fork-on-attach: a
//     structuredClone at the boundary, so the library org is never mutated — see blueprintTeam.ts).
// 2 · TEAM EDITOR — the org designer canvas (TeamsCanvas + TeamsInspector via the org feature barrel,
//     inside the shared GraphCanvas pan/zoom shell) bound to `bp.team`: positions list, click-to-
//     connect relationships, node drag, auto-organize. Every edit flows back through `onChange`
//     like every other author view. Scoped down from TeamsPanel: no pools/drill, no context menu,
//     no persisted zoom — deletion lives in the inspector's two-step confirm.
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Chip } from "@/shared/ui/data/Chip";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import {
  TeamsCanvas, OrgLegend, TeamsInspector, RELATIONSHIP_ARCHETYPES,
  autoLayout, positionDisplay, hueColor, CANVAS_W, CANVAS_H,
  type Team, type Selection,
} from "@/features/teams";
import type { BlueprintTeam } from "@/features/planner/stages/blueprints";
import {
  blankTeam, forkTeamFromOrg, teamAsOrg,
  teamAddPosition, teamUpdatePosition, teamRemovePosition,
  teamAddRelationship, teamUpdateRelationship, teamRemoveRelationship, teamApplyLayout,
} from "../blueprintTeam";
import { Lbl, type AuthorViewProps } from "./shared";

/** No selection sentinel (matches TeamsPanel): inspector hidden, no dimming. */
const NO_SEL: Selection = { type: "node", id: "" };

/** Step 1 — pick the team's starting point: a library org (forked in) or a blank canvas. */
function ArchetypePicker({ orgs, onPick }: { orgs: Team[]; onPick: (team: BlueprintTeam) => void }) {
  return (
    <Stack gap={10}>
      <Text as="div" size={12} tone="muted" style={{ lineHeight: 1.5 }}>
        Start from an org archetype — a deep copy becomes this blueprint's own team, so editing it
        never changes the library — or start blank.
      </Text>
      {orgs.map((o) => (
        <Row key={o.id} gap={11} align="center" onClick={() => onPick(forkTeamFromOrg(o))}
          data-testid={`team-archetype-${o.id}`}
          style={{ padding: "11px 13px", borderRadius: 10, cursor: "pointer",
            border: "1px solid var(--border)", background: "var(--bg-elev)" }}>
          <IconBox size={30} radius={8} fontSize={14} color="var(--accent)"
            background="color-mix(in oklch, var(--accent) 12%, transparent)">◆</IconBox>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Row gap={7} align="center">
              <Text as="span" weight={600} size={13}>{o.name}</Text>
              {o.builtin && <Chip color="var(--accent)">built-in</Chip>}
            </Row>
            <Text as="div" size={11} tone="muted" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {o.blurb || `${o.positions.length} positions · ${o.relationships.length} relationships`}
            </Text>
          </Box>
          <Text as="span" mono size={10} tone="dim">fork →</Text>
        </Row>
      ))}
      <Row gap={11} align="center" onClick={() => onPick(blankTeam())} data-testid="team-archetype-blank"
        style={{ padding: "11px 13px", borderRadius: 10, cursor: "pointer",
          border: "1.5px dashed var(--border)", background: "transparent" }}>
        <IconBox size={30} radius={8} fontSize={14} color="var(--fg-muted)" background="var(--bg-soft)">＋</IconBox>
        <Box style={{ flex: 1 }}>
          <Text as="div" weight={600} size={13}>Start blank</Text>
          <Text as="div" size={11} tone="muted" style={{ marginTop: 2 }}>An empty canvas — add positions and wire them up yourself.</Text>
        </Box>
      </Row>
    </Stack>
  );
}

/** Step 2 — the org designer canvas bound to `bp.team` (the fork; never the library). */
function TeamEditor({ team, onTeam, onReset }: {
  team: BlueprintTeam;
  onTeam: (team: BlueprintTeam) => void;
  /** Discard the team and return to the archetype picker. */
  onReset: () => void;
}) {
  const personas = useAppStore((s) => s.personas);
  const orgs = useAppStore((s) => s.teams);
  // The synthetic Team lens over the team — the org machinery (geometry/derivation) reads it as-is.
  const asOrg = teamAsOrg(team);

  const [sel, setSel] = useState<Selection>(NO_SEL);
  // Click-to-connect: a chosen archetype + the pending source node; two node clicks make an edge.
  const [connect, setConnect] = useState<{ archetype: string; from: string | null } | null>(null);

  const vp = useGraphViewport({ w: CANVAS_W, h: CANVAS_H }, { min: 0.3, max: 1.5, fitPad: 20, maxFitScale: 1.2 });
  // Frame the forked graph once on mount.
  useEffect(() => { vp.fit(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const onSelectNode = (nodeId: string) => {
    if (connect) {
      if (!connect.from) { setConnect({ ...connect, from: nodeId }); return; }
      if (connect.from !== nodeId) {
        const id = `rel-${connect.from}-${nodeId}-${connect.archetype}`;
        if (!team.relationships.some((r) => r.id === id)) {
          onTeam(teamAddRelationship(team, { id, archetype: connect.archetype, from: connect.from, to: nodeId }));
        }
        setSel({ type: "edge", id });
      }
      setConnect(null);
      return;
    }
    setSel({ type: "node", id: nodeId });
  };

  const addNode = () => {
    const nodeId = `pos-${Date.now().toString(36)}`;
    // Drop the new node into clear space below the current graph (mirrors TeamsPanel.addNode).
    const maxY = team.positions.reduce((m, p) => Math.max(m, p.y ?? 0), 0);
    const x = 60 + (team.positions.length % 4) * 220;
    const y = team.positions.length ? maxY + 150 : 48;
    onTeam(teamAddPosition(team, { nodeId, kind: "agent", personaId: personas[0]?.id, x, y }));
    setSel({ type: "node", id: nodeId });
  };

  const hasSel = sel.id !== "";

  return (
    <Box style={{ height: 520, display: "flex", flexDirection: "column", borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)" }}>
      <GraphCanvas
        vp={vp}
        world={{ w: CANVAS_W, h: CANVAS_H }}
        overlays={<OrgLegend />}
        grid
        railResizable railWidth={200} railMin={160} railMax={320}
        inspectorResizable inspectorWidth={300} inspectorMin={250} inspectorMax={460}
        onBackgroundClick={() => setSel(NO_SEL)}
        toolbar={
          <>
            <Row gap={9} align="center" style={{ flex: "none" }}>
              <IconBox size={22} radius={6} fontSize={12} background="var(--bg-soft)" border="1px solid var(--border)" color="var(--accent)">◆</IconBox>
              <Text as="span" mono size={10.5} tone="dim">{team.positions.length} positions · {team.relationships.length} rels</Text>
            </Row>
            <Box style={{ width: 1, height: 22, background: "var(--border)" }} />
            <Row gap={10} align="center" style={{ minWidth: 0 }}>
              <SectionLabel size={9.5} style={{ flex: "none" }}>{connect ? (connect.from ? "pick a target" : "pick a source") : "Click to connect"}</SectionLabel>
              <Row gap={6} style={{ overflowX: "auto" }}>
                {RELATIONSHIP_ARCHETYPES.map((a) => (
                  <Box as="button" key={a.id} onClick={() => setConnect(connect?.archetype === a.id ? null : { archetype: a.id, from: null })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 500,
                      color: "var(--fg-muted)", background: connect?.archetype === a.id ? "color-mix(in oklch, var(--accent) 16%, transparent)" : "var(--bg-soft)",
                      border: `1px solid ${connect?.archetype === a.id ? "var(--accent)" : "var(--border)"}`, padding: "3px 9px 3px 7px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <StatusDot color={hueColor(a.hue)} size={8} />{a.label}
                  </Box>
                ))}
              </Row>
            </Row>
            <Box style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => onTeam(teamApplyLayout(team, autoLayout(asOrg)))}>⤢ Auto organize</Button>
            <Button variant="ghost" onClick={vp.fit}>Fit</Button>
            <ZoomControls vp={vp} />
            <ConfirmButton size="sm" label="↺ restart" armedLabel="Confirm — discards this team" onConfirm={onReset} />
          </>
        }
        rail={
          <Stack gap={0} style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--border-soft)", background: "var(--bg-elev)", minHeight: 0 }}>
            <Row align="center" justify="between" style={{ padding: "13px 15px 11px", borderBottom: "1px solid var(--border-soft)" }}>
              <SectionLabel size={9.5}>Positions</SectionLabel>
              <Button variant="ghost" onClick={addNode}>＋ new</Button>
            </Row>
            <Box style={{ overflowY: "auto", padding: "8px 8px 20px", flex: 1 }}>
              {team.positions.map((p) => {
                const d = positionDisplay(p, personas);
                const on = sel.type === "node" && sel.id === p.nodeId;
                return (
                  <Row key={p.nodeId} gap={9} align="center" onClick={() => onSelectNode(p.nodeId)}
                    style={{ padding: "7px 9px", borderRadius: 8, cursor: "pointer",
                      background: on ? "color-mix(in oklch, var(--accent) 10%, transparent)" : "transparent",
                      border: `1px solid ${on ? "var(--accent)" : "transparent"}` }}>
                    <IconBox size={20} radius={6} fontSize={11} color="var(--accent)" background="var(--bg-soft)">{d.glyph}</IconBox>
                    <Text as="span" size={12.5} weight={500} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</Text>
                    {d.role && <Text as="span" mono size={9} tone="dim" style={{ textTransform: "uppercase" }}>{d.role}</Text>}
                  </Row>
                );
              })}
            </Box>
          </Stack>
        }
        inspector={hasSel ? (
          <TeamsInspector
            org={asOrg} orgs={[asOrg, ...orgs]} personas={personas} sel={sel}
            onSelectNode={(id) => setSel({ type: "node", id })}
            onChangeArchetype={(relId, a) => onTeam(teamUpdateRelationship(team, relId, { archetype: a }))}
            onChangePersona={(nodeId, personaId) => onTeam(teamUpdatePosition(team, nodeId, { personaId }))}
            onChangeLabel={(nodeId, label) => onTeam(teamUpdatePosition(team, nodeId, { label }))}
            onDeletePosition={(nodeId) => { onTeam(teamRemovePosition(team, nodeId)); setSel(NO_SEL); }}
            onDeleteRelationship={(relId) => { onTeam(teamRemoveRelationship(team, relId)); setSel(NO_SEL); }}
          />
        ) : undefined}
      >
        <TeamsCanvas
          org={asOrg} personas={personas} sel={sel} scale={vp.view.scale} connecting={!!connect}
          dragMoved={vp.dragMoved}
          onSelectNode={onSelectNode} onSelectEdge={(id) => setSel({ type: "edge", id })}
          onMoveNode={(nodeId, x, y) => onTeam(teamUpdatePosition(team, nodeId, { x, y }))}
        />
      </GraphCanvas>
    </Box>
  );
}

/** The Team author view (#2450): fork an org archetype into `bp.team`, then edit it on the org
 *  designer canvas. Emits the whole blueprint via `onChange` like every other author view. */
export function TeamView({ bp, onChange }: AuthorViewProps) {
  const orgs = useAppStore((s) => s.teams);
  const setTeam = (team: BlueprintTeam | undefined) => onChange({ ...bp, team });
  return (
    <Stack gap={18}>
      <Box>
        <Lbl hint={bp.team ? "this blueprint's own org — edits never touch the library" : "fork an archetype or start blank"}>Team</Lbl>
        {bp.team ? (
          <TeamEditor team={bp.team} onTeam={setTeam} onReset={() => setTeam(undefined)} />
        ) : (
          <ArchetypePicker orgs={orgs} onPick={setTeam} />
        )}
      </Box>
    </Stack>
  );
}
