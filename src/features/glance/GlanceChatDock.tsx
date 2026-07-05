// Glance agent stream dock (#2369) — presents a LIVE fleet agent's real PTY stream + its logs, docked
// at the bottom of the Glance page. Opened from the inspector's "Open stream" button for a live drilled
// agent. This is the step that lets the console page retire (#2205 direction): the graph, not a tab
// grid, hosts the terminal.
//
// Reuse-first + zero reinvention: the "Stream" tab is the SAME <TerminalView> the console renders,
// keyed by the agent's identity pane id (`<project>:<stream>`), so it inherits everything — the
// scrollback bounding (scrollbackForPaneCount), the capped hidden-buffer (PendingPtyData), and
// reconnect-not-respawn (pty_create returns isNew=false for the already-live PTY). Only one mount is
// ever VISIBLE (the console's copy is display:none while you're in Glance), so the two mounts never
// fight over PTY sizing. The "Logs" tab is the shared sessionLog surface.
import { useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TerminalView } from "@/app/console/panes/views/TerminalView";
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

  return (
    <Box style={{
      height: "40vh", minHeight: 240, flex: "none",
      borderTop: "1px solid var(--border)", background: "var(--bg-panel)",
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
          <TerminalView paneId={paneId} visible={tab === "stream"} focused={tab === "stream"} />
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
