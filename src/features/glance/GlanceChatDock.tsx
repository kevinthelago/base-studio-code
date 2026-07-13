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
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TextField } from "@/shared/ui/controls/Field";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { GlanceSessionLog } from "./GlanceSessionLog";

type DockTab = "stream" | "logs";

export function GlanceChatDock({
  paneId, name, role, onClose, onEnd,
}: {
  paneId: string;
  name: string;
  role?: string;
  /** Collapse the dock back into its node — the PTY stays ALIVE (the agent is untouched). */
  onClose: () => void;
  /** END the session — kill the PTY so a stuck / soft-locked agent is fully torn down and triage can
   *  be relaunched cleanly (#3049). Undefined ⇒ the End-session button is omitted. */
  onEnd?: () => void;
}) {
  const [tab, setTab] = useState<DockTab>("stream");
  const [draft, setDraft] = useState("");
  // Hide the chat input while the CLI is actively working (#2534): the pane's authoritative turn state
  // ("run" = a turn in flight, driven by the bsc-activity hooks) means the agent isn't at a prompt, so a
  // raw pty_write would land mid-TUI. The input returns the moment the turn closes ("on"/idle).
  const running = useAppStore((s) => s.paneStatus[paneId] === "run");

  // Send a chat message to the agent: write it to its PTY + Enter, exactly as the fleet's steer/answer
  // does (fireInvoke pty_write). The PTY echoes it back into the stream above, so the terminal IS the
  // chat history — this input is just an explicit "type here" affordance over it.
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    fireInvoke("pty_write", { paneId, data: text + "\r" }, console.error);
    setDraft("");
  };

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
          {(["stream", "logs"] as DockTab[]).map((t) => (
            <Button key={t} size="sm" variant={tab === t ? "primary" : "ghost"} onClick={() => setTab(t)}>
              {t === "stream" ? "Stream" : "Logs"}
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
          {/* The live PTY stream = the chat history. Not auto-focused, so the chat input below is the
              default target; click into the terminal to interact with its TUI directly. */}
          <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {/* Viewer slot (not primary): the host re-parents the agent's single terminal here while the
                dock is open. `visible` gates its render/fit exactly like a background console pane. */}
            <TerminalSlot paneId={paneId} visible={tab === "stream"} focused={false} />
          </Box>
          {running ? (
            // CLI is working — no prompt to type at, so show status instead of the input (#2534).
            <Row gap="sm" align="center" style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", flex: "none" }}>
              <Box style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flex: "none", animation: "glance-softpulse 1.4s ease-in-out infinite" }} />
              <Text mono size="xs" tone="dim">working — input returns when the agent is ready</Text>
            </Row>
          ) : (
            <Row gap="sm" align="center" style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", flex: "none" }}>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  value={draft}
                  onChange={setDraft}
                  placeholder="Message the agent — Enter to send"
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
              </Box>
              <Button size="sm" variant="primary" onClick={send} disabled={!draft.trim()}>Send</Button>
            </Row>
          )}
        </Box>
        {tab === "logs" && (
          <Box style={{ position: "absolute", inset: 0 }}>
            <GlanceSessionLog paneId={paneId} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
