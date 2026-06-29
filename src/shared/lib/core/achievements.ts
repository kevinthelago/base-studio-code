// Achievement registry (#365 Easter egg, generalized). Definitions are static; the
// UNLOCKED state lives in the persisted store (`achievements: id -> unlockedAt`),
// so an achievement fires exactly once, ever, and survives restarts.

import type { AppStore } from "@/store/types";
import superUserIcon from "@/assets/super-user-achievement.png";

export interface AchievementDef {
  /** Stable id (the store key). */
  id: string;
  title: string;
  description: string;
  /** Imported image asset shown on the Settings page (and the unlock toast). */
  icon: string;
  /** Optional unlock-toast sound (defaults to the shared achievement sound). */
  sound?: string;
  /** Live unlock condition: a pure store selector that turns true when the achievement should fire.
   *  Entries with a `trigger` get a live unlock toast (mounted by `<Achievements/>`); ones without
   *  are unlocked imperatively elsewhere but still appear in the Settings trophy case. */
  trigger?: (s: AppStore) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "super-user",
    title: "Claude Super User",
    description: "Run more than 10 agents at once.",
    icon: superUserIcon,
    trigger: (s) => s.liveAgents > 10,
  },
];

export function achievementById(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** Pure: whether `id` is unlocked in the given map. */
export function isUnlocked(unlocked: Record<string, number>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(unlocked, id);
}

/** Pure: decide the next unlocked-map for an unlock attempt. Returns `null` when `id`
 *  is already unlocked (idempotent — caller should NOT re-fire the toast), else the
 *  new map with `id` stamped at `now`. Keeps the once-ever guarantee testable. */
export function unlock(
  unlocked: Record<string, number>,
  id: string,
  now: number,
): Record<string, number> | null {
  if (isUnlocked(unlocked, id)) return null;
  return { ...unlocked, [id]: now };
}
