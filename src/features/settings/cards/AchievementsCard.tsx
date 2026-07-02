import { useAppStore } from "@/store";
import { ACHIEVEMENTS, isUnlocked } from "@/shared/lib/core/achievements";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";

// Settings > Achievements: the persistent trophy case. Each achievement shows its
// icon (full-color when unlocked, dimmed + grayscale when locked) and, once earned,
// the date it was unlocked. Unlocks are once-ever and survive restarts (store).
export function AchievementsCard() {
  const achievements = useAppStore((s) => s.achievements);
  const unlockedCount = ACHIEVEMENTS.filter((a) => isUnlocked(achievements, a.id)).length;

  return (
    <div style={{ maxWidth: 640 }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 4 }}>
        <h2 className="mono" style={{ fontSize: 16, margin: 0, color: "var(--fg)" }}>Achievements</h2>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
          {unlockedCount}/{ACHIEVEMENTS.length} unlocked
        </span>
      </Row>
      <p className="mono" style={{ fontSize: 11, color: "var(--fg-muted)", margin: "0 0 18px" }}>
        Milestones you have earned. Each unlocks once and is kept across restarts.
      </p>

      <Stack gap={10}>
        {ACHIEVEMENTS.map((a) => {
          const at = achievements[a.id];
          const unlocked = at != null;
          return (
            <Row key={a.id} gap={14} style={{
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
                <div className="mono" style={{ fontSize: 13, color: "var(--fg)" }}>
                  {a.title}{!unlocked && <span style={{ color: "var(--fg-dim)", fontSize: 11 }}> · locked</span>}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
                  {a.description}
                </div>
                {unlocked && (
                  <div className="mono" style={{ fontSize: 10, color: "var(--accent)", marginTop: 4 }}>
                    Unlocked {new Date(at).toLocaleDateString()}
                  </div>
                )}
              </div>
            </Row>
          );
        })}
      </Stack>
    </div>
  );
}
