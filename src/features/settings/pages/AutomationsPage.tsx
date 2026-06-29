import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/Card";

const prose: React.CSSProperties = { fontFamily: "var(--sans)", fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" };

export function AutomationsPage() {
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Automations</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        How scheduled automations run against your console sessions.
      </p>

      <Card title="Automations">
        <div style={prose}>
          <p style={{ margin: "0 0 10px 0" }}>
            An <strong>automation</strong> is a cron-triggered rule that dispatches a command into a
            specified console pane. An always-on background scheduler fires armed automations at their
            next run time and records each run.
          </p>
          <p style={{ margin: "0 0 14px 0" }}>
            Create schedules, arm or disarm them, choose the target pane and action, and review run
            history on the Automations screen.
          </p>
          <button className="btn" onClick={() => setWorkspace("automation")}>Open Automations →</button>
        </div>
      </Card>
    </div>
  );
}
