import { useAppStore } from "@/store";
import { SettingsCardHead, ToggleRow } from "../pages/SettingsControls";

export function SessionsBehaviorCard() {
  const {
    autoResumeClaude, setAutoResumeClaude,
    autoAdvanceOnReply, setAutoAdvanceOnReply,
  } = useAppStore();

  return (
    <div className="card">
      <SettingsCardHead title="Sessions & console behavior" />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ToggleRow
          on={autoResumeClaude}
          onToggle={() => setAutoResumeClaude(!autoResumeClaude)}
          title="Auto-resume Claude on restart"
        >
          Panes that had Claude running at last shutdown relaunch it with <code>--continue</code> when
          the app reopens, restoring the prior conversation. Off means panes start at a bare bash
          prompt; you'd type <code>claude</code> yourself.
        </ToggleRow>
        <ToggleRow
          on={autoAdvanceOnReply}
          onToggle={() => setAutoAdvanceOnReply(!autoAdvanceOnReply)}
          title="Cycle to next console on reply"
        >
          When you send a response to a console, jump focus to the next one waiting in the queue
          (Ctrl+Shift+N cycles manually). Works while maximized.
        </ToggleRow>
      </div>
    </div>
  );
}
