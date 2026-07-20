import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";

/**
 * Toggle: show the DEBUG session in the base-studio-code Glance graph (#3327; was a separate OS window,
 * #3298). A full-capability Claude session in the app's SOURCE tree that works the `bsc request`
 * improvement queue — the queue the Design Studio's designer files its `bsc ui` painpoints into. Flipping
 * this on adds the `debugger` node to the base-studio-code project graph (via `augmentStudioNetworkForDebug`);
 * off removes it. Session-only (not persisted).
 */
export function DebugSessionCard() {
  const { debugSession, setDebugSession, autoSpawnDebugSessions, setAutoSpawnDebugSessions } = useAppStore();
  return (
    <Card title="Debug session">
      <ToggleRow on={debugSession} onToggle={() => setDebugSession(!debugSession)} title="Show the debug session in the base-studio-code graph">
        Adds the <b>debugger</b> node to the base-studio-code project in the Glance graph — a
        <b> full-capability Claude session in this app's source tree</b> that works the <code>bsc request</code>{" "}
        queue (the improvement requests the Design Studio's designer files when it hits a missing{" "}
        <code>bsc ui</code> capability), reproducing each, fixing it in <code>crates/bsc-ui</code> on a
        branch, and resolving the request. Available only on a machine with the source tree (a dev build).
      </ToggleRow>
      <ToggleRow
        on={autoSpawnDebugSessions}
        onToggle={() => setAutoSpawnDebugSessions(!autoSpawnDebugSessions)}
        title="Let a filed request start a debug session automatically"
      >
        When on, filing a <code>bsc request</code> may start a debug session to work it, instead of the
        request waiting in a queue for someone to open one. <b>Off by default.</b> This is the only
        automatic session start in the app, and it is deliberately narrow: <b>only the{" "}
        <code>debugger</code> session can ever be started this way</b> — no designer, librarian,
        architect, curator, planner or worker session is auto-spawnable, whatever this is set to. Leave
        it off unless you want the app starting a session without asking.
      </ToggleRow>
    </Card>
  );
}
