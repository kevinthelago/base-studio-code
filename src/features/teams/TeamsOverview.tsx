// Teams overview (#2742) — the TOP graph level: each team is a clickable card. Clicking a card enters
// that team (the per-team position graph). This is what replaced the header org-switcher dropdown —
// navigation happens IN the graph now. Teams are configured by the AI, not created by the user, so
// there is no "＋ New team" card (#2750). Renders the world-layer content inside GraphCanvas's
// transformed world box, like TeamsCanvas does for positions.
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { IconBox } from "@/shared/ui/data/IconBox";
import { teamsGrid, teamStats } from "./lib/teamsLayout";
import type { Team } from "./lib/team";
import type { Persona } from "@/features/personas";
import "./teams.css";

interface Props {
  teams: Team[];
  personas: Persona[];
  /** Enter a team's position graph (a card click). */
  onEnter: (teamId: string) => void;
}

export function TeamsOverview({ teams, personas, onEnter }: Props) {
  // One grid cell per team (teams are AI-configured — there is no "new team" card, #2750).
  const cells = teamsGrid(teams.length);

  return (
    <>
      {teams.map((team, i) => {
        const b = cells[i];
        const s = teamStats(team, personas);
        return (
          // eslint-disable-next-line no-restricted-syntax -- data-node marks the card as owning its press (no background pan/deselect)
          <div key={team.id} data-node={team.id} onPointerDown={(e) => e.stopPropagation()} onClick={() => onEnter(team.id)}
            style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, cursor: "pointer" }}>
            <Box className="teams-card" style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "13px 15px",
              display: "flex", flexDirection: "column", gap: 8, borderRadius: 14, background: "var(--bg-elev)",
              border: "1px solid var(--border)", boxShadow: "0 3px 12px rgba(0,0,0,.3)" }}>
              <Row gap={10} align="center">
                <IconBox size={26} radius={8} fontSize={13} color="var(--accent)" background="color-mix(in oklch, var(--accent) 14%, transparent)">◆</IconBox>
                <Text as="span" weight={600} size={14.5} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</Text>
              </Row>
              {team.blurb && <Text as="div" size={11.5} tone="muted" style={{ lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical" }}>{team.blurb}</Text>}
              <Box style={{ flex: 1 }} />
              <Row gap={12} align="center">
                <Text as="span" mono size={10} tone="dim">◆ {s.agents} agent{s.agents === 1 ? "" : "s"}</Text>
                <Text as="span" mono size={10} tone="dim">· {s.positions} position{s.positions === 1 ? "" : "s"}</Text>
                {s.externals > 0 && <Text as="span" mono size={10} tone="dim">· {s.externals} ext</Text>}
              </Row>
            </Box>
          </div>
        );
      })}
    </>
  );
}
