// Automations stage body (split from FocusedBodies.tsx #1757).
import type { PaneAutomation } from "@/features/planner/pane/projectPaneData";

export function FocusedAutomationsBody({ automations }: { automations?: PaneAutomation[] }) {
  const list = automations ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⏱</span>
        <span>No automations yet</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {list.map((a) => (
        <div key={a.name} style={{
          padding: "8px 10px", borderRadius: 6,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{a.name}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>
            {a.command}{a.schedule ? ` · ${a.schedule}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
