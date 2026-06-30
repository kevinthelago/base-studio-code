import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";

/** Agent permission posture (#1916): the deny-list (bypass — auto-run, hooks gate) vs the allow-list
 *  (require approval). The toggle threads through `buildSessionSettings` → `write_session_settings`,
 *  which emits (or omits) `permissions.defaultMode = "bypassPermissions"`. Takes effect next launch. */
export function PermissionPostureCard() {
  const { bypassPermissions, setBypassPermissions } = useAppStore();

  return (
    <Card title="Agent permissions">
      <ToggleRow
        on={bypassPermissions}
        onToggle={() => setBypassPermissions(!bypassPermissions)}
        title="Autonomous agents (deny-list)"
      >
        When on (default), sessions <b>auto-run without prompts</b> and a set of always-on guards do the
        gating — the dangerous-command floor, each role's denied commands, filesystem confinement to the
        worktree, and the write-scope rules (all enforced by PreToolUse hooks, which hold even in this
        mode). The push-confirm gate still pauses for approval. Turn <b>off</b> to use the classic{" "}
        <b>allow-list</b> instead: every command not on the enumerated allow-list prompts for approval —
        more friction, tighter control. Applies to every session — fleet agents <i>and</i> your manual
        consoles. Takes effect on the next session launch.
      </ToggleRow>
    </Card>
  );
}
