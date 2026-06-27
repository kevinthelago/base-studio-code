// Skills stage body (#1056, split from FocusedBodies.tsx #1757).
import type { PaneSkill } from "@/features/planner/pane/projectPaneData";

export function FocusedSkillsBody({ skills }: { skills?: PaneSkill[] }) {
  const list = skills ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◈</span>
        <span>No skills attached</span>
      </div>
    );
  }
  // Skills authored by this planning session (#1056) render FIRST and highlighted, so freshly
  // generated skills are obvious. Stable sort keeps each group's original order.
  const ordered = [...list].sort((a, b) => Number(b.isNew ?? false) - Number(a.isNew ?? false));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {ordered.map((s) => (
        <div key={s.name} style={{
          padding: "8px 10px", borderRadius: 6,
          background: s.isNew ? "var(--accent-soft)" : "var(--bg-canvas)",
          border: s.isNew ? "1px solid var(--accent)" : "1px solid var(--border-soft)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{s.name}</div>
            {s.isNew && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 8.5, fontWeight: 600, letterSpacing: ".04em",
                color: "var(--accent-text)", background: "var(--accent)", borderRadius: 4, padding: "1px 5px",
              }}>NEW</span>
            )}
          </div>
          {s.desc && <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>{s.desc}</div>}
        </div>
      ))}
    </div>
  );
}
