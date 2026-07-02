import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { ACHIEVEMENTS, type AchievementDef } from "@/shared/lib/core/achievements";
import achievementSound from "@/assets/achievement-sound.mp3";
import "./achievement.css";

// Easter-egg achievement toasts (#365), registry-driven. Each ACHIEVEMENTS entry that declares a
// `trigger` gets one <Achievement>: when its trigger first becomes true it swipes the icon down from
// the top (with a spring bounce) and plays a sound, holds, then swipes away. Unlocks ONCE, EVER — the
// unlock is persisted via the store (unlockAchievement returns true only on the first unlock), so a
// later re-crossing never re-fires it. Adding a new achievement is a single ACHIEVEMENTS entry — no
// new component. Unlocked ones are shown in Settings.

type Phase = "hidden" | "in" | "out";

/** Stable fallback selector for an achievement with no `trigger` (never fires). */
const NEVER = () => false;

/** One achievement's unlock toast, driven entirely by its registry `def`. */
function Achievement({ def }: { def: AchievementDef }) {
  const { id, sound } = def;
  // Subscribe to just this achievement's trigger boolean, so the component re-renders only when the
  // condition flips (Zustand selector equality) — not on every store change.
  const triggered = useAppStore(def.trigger ?? NEVER);
  const unlockAchievement = useAppStore((s) => s.unlockAchievement);
  const [phase, setPhase] = useState<Phase>("hidden");
  const wasOnRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // unlockAchievement is idempotent: true only the FIRST time `id` is ever unlocked, so the toast
    // plays exactly once across all sessions.
    if (triggered && !wasOnRef.current && unlockAchievement(id)) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setPhase("in");
      try {
        const audio = new Audio(sound ?? achievementSound);
        audio.volume = 0.7;
        void audio.play().catch(() => {});
      } catch {
        // autoplay blocked before a user gesture is fine; the visual still plays
      }
      // Hold, then swipe away. in-animation ~0.95s, hold to ~4.2s, out ~0.5s.
      timersRef.current.push(setTimeout(() => setPhase("out"), 4200));
      timersRef.current.push(setTimeout(() => setPhase("hidden"), 4750));
    }
    wasOnRef.current = triggered;
  }, [triggered, unlockAchievement, id, sound]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  if (phase === "hidden") return null;
  return (
    <Box className="achv-wrap" aria-hidden>
      <img
        src={def.icon}
        alt={`${def.title} achievement unlocked`}
        className={"achv " + phase}
        draggable={false}
      />
    </Box>
  );
}

/** Mounts an unlock toast for every registry achievement that has a live `trigger` — the single
 *  thing the app shell renders for the whole achievement system. */
export function Achievements() {
  return (
    <>
      {ACHIEVEMENTS.filter((a) => a.trigger).map((a) => (
        <Achievement key={a.id} def={a} />
      ))}
    </>
  );
}
