import { useAppStore } from "../../store";
import { ACHIEVEMENTS, isUnlocked } from "../../lib/core/achievements";

// Settings > Achievements: the persistent trophy case. Each achievement shows its
// icon (full-color when unlocked, dimmed + grayscale when locked) and, once earned,
// the date it was unlocked. Unlocks are once-ever and survive restarts (store).
export function AchievementsSettings() {
  const achievements = useAppStore((s) => s.achievements);
  const unlockedCount = ACHIEVEMENTS.filter((a) => isUnlocked(achievements, a.id)).length;

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontFamily: "var(--mono)", fontSize: 16, margin: 0, color: "var(--fg)" }}>Achievements</h2>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>
          {unlockedCount}/{ACHIEVEMENTS.length} unlocked
        </span>
      </div>
      <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)", margin: "0 0 18px" }}>
        Milestones you have earned. Each unlocks once and is kept across restarts.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ACHIEVEMENTS.map((a) => {
          const at = achievements[a.id];
          const unlocked = at != null;
          return (
            <div key={a.id} style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: 12, borderRadius: 10,
              background: "var(--bg-panel)",
              border: "1px solid " + (unlocked ? "var(--accent)" : "var(--border-soft)"),
              opacity: unlocked ? 1 : 0.7,
            }}>
              <img
                src={a.icon}
                alt={a.title}
                width={48}
                height={48}
                draggable={false}
                style={{
                  flexShrink: 0, borderRadius: 8, objectFit: "contain",
                  filter: unlocked ? "none" : "grayscale(1) brightness(0.6)",
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>
                  {a.title}{!unlocked && <span style={{ color: "var(--fg-dim)", fontSize: 11 }}> · locked</span>}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
                  {a.description}
                </div>
                {unlocked && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", marginTop: 4 }}>
                    Unlocked {new Date(at).toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
