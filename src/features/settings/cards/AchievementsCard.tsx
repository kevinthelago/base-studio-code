import { useAppStore } from "@/store";
import { ACHIEVEMENTS, isUnlocked } from "@/shared/lib/core/achievements";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

// Settings > Achievements: the persistent trophy case. Each achievement shows its
// icon (full-color when unlocked, dimmed + grayscale when locked) and, once earned,
// the date it was unlocked. Unlocks are once-ever and survive restarts (store).
export function AchievementsCard() {
  const achievements = useAppStore((s) => s.achievements);
  const unlockedCount = ACHIEVEMENTS.filter((a) => isUnlocked(achievements, a.id)).length;

  return (
    <Box style={{ maxWidth: 640 }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 4 }}>
        <h2 className="mono" style={{ fontSize: 16, margin: 0, color: "var(--fg)" }}>Achievements</h2>
        <Text mono size={11} tone="dim">
          {unlockedCount}/{ACHIEVEMENTS.length} unlocked
        </Text>
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
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text as="div" mono size={13} style={{ color: "var(--fg)" }}>
                  {a.title}{!unlocked && <Text size={11} tone="dim"> · locked</Text>}
                </Text>
                <Text as="div" mono size={11} tone="muted" style={{ marginTop: 2 }}>
                  {a.description}
                </Text>
                {unlocked && (
                  <Text as="div" mono size={10} tone="accent" style={{ marginTop: 4 }}>
                    Unlocked {new Date(at).toLocaleDateString()}
                  </Text>
                )}
              </Box>
            </Row>
          );
        })}
      </Stack>
    </Box>
  );
}
