// Glance agent stream dock (#2369) — presents a LIVE fleet agent's real PTY stream + its logs, docked
// at the bottom of the Glance page. Opened from the inspector's "Open stream" button for a live drilled
// agent. This is the step that lets the console page retire (#2205 direction): the graph, not a tab
// grid, hosts the terminal.
//
// Reuse-first + zero reinvention: the "Stream" tab drops a <TerminalSlot> for the agent's identity pane
// id (`<project>:<stream>`). Since #2378 there is exactly ONE terminal per agent — owned by the app-level
// TerminalHost — and the slot RE-PARENTS it into the dock while it's open (parked back to the console cell
// on close), so the dock inherits everything the console has (scrollback bounding, the capped
// hidden-buffer, reconnect-not-respawn) with NO second xterm and no PTY-sizing coordination hack. The
// "Logs" tab is the shared sessionLog surface.
import { useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { GlanceSessionLog } from "./GlanceSessionLog";
import { GlancePlanScreen, planScreenIssues } from "./GlancePlanScreen";
import type { StreamProgress } from "./lib/streamProgress";

type DockTab = "stream" | "logs" | "plan";

/** The worker's owned work (#4102), resolved once at the workspace and threaded down. Passed in rather
 *  than fetched here on purpose: every open morph mounts its own dock, so a fetch at this level would be
 *  one query per open node — the fan-out this feature was explicitly built to avoid. Undefined ⇒ the
 *  node is not a fleet worker (a studio/debug session), so the Plan tab is omitted entirely. */
export interface DockPlan {
  /** Issue refs this worker owns, in PLAN order. */
  refs: readonly string[];
  /** ref (unprefixed) → closed. Empty when GitHub is unavailable. */
  states: ReadonlyMap<string, boolean>;
  progress?: StreamProgress;
  /** The state overlay could not be fetched — the list still renders. */
  unresolved?: boolean;
  loading?: boolean;
}

export function GlanceChatDock({
  paneId, name, role, plan, onClose, onEnd,
}: {
  paneId: string;
  name: string;
  role?: string;
  /** This worker's owned issues (#4102). Undefined ⇒ no Plan tab. */
  plan?: DockPlan;
  /** Collapse the dock back into its node — the PTY stays ALIVE (the agent is untouched). */
  onClose: () => void;
  /** END the session — kill the PTY so a stuck / soft-locked agent is fully torn down and triage can
   *  be relaunched cleanly (#3049). Undefined ⇒ the End-session button is omitted. */
  onEnd?: () => void;
}) {
  const [tab, setTab] = useState<DockTab>("stream");

  return (
    // Fills its container (#2401): the morph panel owns the frame (border/radius/shadow) + sizing, so
    // this is a plain fill — height:100%, no bottom-dock border. (Was a fixed 40vh bottom dock.)
    <Box style={{
      height: "100%", minHeight: 0, flex: 1,
      background: "var(--bg-panel)",
      display: "flex", flexDirection: "column", minWidth: 0,
    }}>
      <Row justify="between" align="center" style={{ padding: "7px 12px", borderBottom: "1px solid var(--border)", flex: "none" }}>
        <Row gap="sm" align="baseline" style={{ minWidth: 0 }}>
          <Text mono size="md" weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</Text>
          {role && <Text mono size="xs" tone="dim" style={{ flex: "none" }}>{role}</Text>}
          <Text mono size="xs" tone="dim" style={{ flex: "none" }}>· live</Text>
        </Row>
        <Row gap="sm" align="center" style={{ flex: "none" }}>
          {/* Plan sits beside Stream and Logs only when this node HAS a plan — a studio or debug
              session owns no issues, and an always-empty tab would read as a bug. */}
          {((plan ? ["stream", "logs", "plan"] : ["stream", "logs"]) as DockTab[]).map((t) => (
            <Button key={t} size="sm" variant={tab === t ? "primary" : "ghost"} onClick={() => setTab(t)}>
              {t === "stream" ? "Stream" : t === "logs" ? "Logs" : "Plan"}
            </Button>
          ))}
          {/* END the session (#3049) — kills the PTY (distinct from the ✕, which only collapses the
              morph and keeps the agent alive). For a soft-locked fleet this fully tears a stuck agent
              down so "Relaunch fleet" can restart triage cleanly. */}
          {onEnd && (
            <Button size="sm" variant="ghost" danger onClick={onEnd} title="Kill this agent's session so triage can be relaunched">
              End session
            </Button>
          )}
          <IconButton aria-label="Collapse stream (agent stays alive)" onClick={onClose}>×</IconButton>
        </Row>
      </Row>

      <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* The terminal stays MOUNTED across tab switches (only hidden) so its PTY is never torn down;
            `visible` gates its render/fit exactly like a background console pane. */}
        <Box style={{ position: "absolute", inset: 0, display: tab === "stream" ? "flex" : "none", flexDirection: "column" }}>
          {/* The live PTY stream IS the interaction surface (#3523): a Claude CLI session has its own TUI
              input (and its own "working" state) inside the terminal, so the dock adds no second input —
              click into the terminal and type at Claude's prompt directly. The separate "message the
              agent" box was a redundant affordance over the same PTY. */}
          <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {/* Viewer slot (not primary): the host re-parents the agent's single terminal here while the
                dock is open. `visible` gates its render/fit exactly like a background console pane. */}
            <TerminalSlot paneId={paneId} visible={tab === "stream"} focused={false} />
          </Box>
        </Box>
        {tab === "logs" && (
          <Box style={{ position: "absolute", inset: 0 }}>
            <GlanceSessionLog paneId={paneId} />
          </Box>
        )}
        {tab === "plan" && plan && (
          <Box style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <GlancePlanScreen
              issues={planScreenIssues(plan.refs, plan.states)}
              progress={plan.progress}
              unresolved={plan.unresolved}
              loading={plan.loading}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
