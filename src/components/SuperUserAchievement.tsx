import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import achievementImg from "../assets/super-user-achievement.png";
import achievementSound from "../assets/achievement-sound.mp3";
import "./superUserAchievement.css";

// Easter egg (#365): when more than 10 agents are running at once, swipe a
// "Super User" achievement down from the top (with a spring bounce) and play a
// sound, hold it, then swipe it away. Unlocks ONCE, EVER — the unlock is persisted
// via the store (unlockAchievement returns true only on the first unlock), so a
// later threshold re-crossing never re-fires it. View unlocked ones in Settings.
const THRESHOLD = 10;

export function SuperUserAchievement() {
  const liveAgents = useAppStore((s) => s.liveAgents);
  const unlockAchievement = useAppStore((s) => s.unlockAchievement);
  const [phase, setPhase] = useState<"hidden" | "in" | "out">("hidden");
  const wasOverRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const over = liveAgents > THRESHOLD;
    // unlockAchievement is idempotent: true only the FIRST time it's ever unlocked,
    // so the toast plays exactly once across all sessions.
    if (over && !wasOverRef.current && unlockAchievement("super-user")) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setPhase("in");
      try {
        const audio = new Audio(achievementSound);
        audio.volume = 0.7;
        void audio.play().catch(() => {});
      } catch {
        // autoplay blocked before a user gesture is fine; the visual still plays
      }
      // Hold, then swipe away. in-animation ~0.95s, hold to ~4.2s, out ~0.5s.
      timersRef.current.push(setTimeout(() => setPhase("out"), 4200));
      timersRef.current.push(setTimeout(() => setPhase("hidden"), 4750));
    }
    wasOverRef.current = over;
  }, [liveAgents, unlockAchievement]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  if (phase === "hidden") return null;
  return (
    <div className="su-achv-wrap" aria-hidden>
      <img
        src={achievementImg}
        alt="Claude Super User achievement unlocked"
        className={"su-achv " + phase}
        draggable={false}
      />
    </div>
  );
}
