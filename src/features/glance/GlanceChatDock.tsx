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
import { TextField } from "@/shared/ui/controls/Field";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { GlanceSessionLog } from "./GlanceSessionLog";

type DockTab = "stream" | "logs";

export function GlanceChatDock({
  paneId, name, role, onClose,
}: {
  paneId: string;
  name: string;
  role?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DockTab>("stream");
  const [draft, setDraft] = useState("");

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
          <IconButton aria-label="Close stream" onClick={onClose}>×</IconButton>
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
