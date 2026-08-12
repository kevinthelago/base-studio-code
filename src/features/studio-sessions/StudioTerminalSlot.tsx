// StudioTerminalSlot (#rendering-a-studio-node-must-not-start-its-session) — what a surface drops where a
// studio session's terminal goes. It renders the live terminal when the studio is RUNNING, and the control
// that starts it when it is not.
//
// It exists because starting a studio stopped being implicit. `useStudioViewer` used to call `openStudio`,
// so any surface that SHOWED a studio also LAUNCHED it — and since a studio page counts as "showing"
// whenever the shell is on that page, navigating to the Design Studio started an agent. Removing that call
// fixes the launch but leaves a hole: `openStudio` was the only caller in the app, so without a deliberate
// affordance a studio could never be started at all.
//
// One component rather than a copy per surface: the studio pages and the Glance morph must agree on what
// "not running" looks like and on how it is started, and three near-identical placeholders would drift.
import { useAppStore } from "@/store";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { Button } from "@/shared/ui/controls/Button";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { STUDIO_SESSIONS, type StudioId } from "./lib/studioSessions";

export interface StudioTerminalSlotProps {
  studio: StudioId;
  /** Whether the host surface is actually on screen — forwarded to the live slot. */
  visible?: boolean;
  focused?: boolean;
}

/** Is this studio's session declared live? `wantedStudios` is exactly "has a terminal on the host".
 *  Local, not exported: a caller that wants this is almost always about to branch on it, and that branch
 *  belongs in the one component below rather than copied into each surface. */
function useStudioRunning(studio: StudioId): boolean {
  return useAppStore((s) => s.wantedStudios.includes(studio));
}

export function StudioTerminalSlot({ studio, visible = true, focused = false }: StudioTerminalSlotProps) {
  const def = STUDIO_SESSIONS[studio];
  const running = useStudioRunning(studio);
  const openStudio = useAppStore((s) => s.openStudio);

  if (running) return <TerminalSlot paneId={def.paneId} visible={visible} focused={focused} />;

  return (
    <Stack
      gap="sm"
      data-testid={`studio-not-running-${def.id}`}
      style={{ height: "100%", alignItems: "center", justifyContent: "center", padding: 16, textAlign: "center" }}
    >
      <Text as="div" tone="muted" style={{ fontSize: 12.5 }}>
        This session is not running.
      </Text>
      <Text as="div" tone="muted" style={{ fontSize: 11.5, maxWidth: 380 }}>
        {/* State the model explicitly: the app never starts one on its own, so an empty dock is the
            expected state rather than something that failed to load. */}
        Sessions start only when you start them — opening this page no longer launches an agent.
      </Text>
      <Button variant="primary" onClick={() => openStudio(studio)}>
        Start {def.rosterName} session
      </Button>
    </Stack>
  );
}

