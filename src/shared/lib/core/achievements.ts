// Achievement registry (#365 Easter egg). Definitions are DATA: one JSON file per achievement under
// `src-tauri/data/achievements/`, loaded via the `@data` glob (mirrors `data/roles/*.json`, #1715), so
// adding an achievement is a single JSON file (+ its icon asset) — no code change. The UNLOCKED state
// lives in the persisted store (`achievements: id -> unlockedAt`), so each fires exactly once, ever.

import type { AppStore } from "@/store/types";

/** A declarative unlock condition authored in JSON: compare a numeric store field to a threshold. */
export interface TriggerSpec {
  /** A numeric field on the app store the condition reads (e.g. "liveAgents"). */
  field: string;
  /** Comparison operator. */
  op: "gt" | "gte" | "lt" | "lte" | "eq";
  value: number;
}

/** The raw JSON shape authored under `data/achievements/*.json`. */
interface RawAchievement {
  id: string;
  title: string;
  description: string;
  /** Icon asset filename under `src/assets/` (e.g. "super-user-achievement.png"). */
  icon: string;
  /** Optional unlock-toast sound filename under `src/assets/` (defaults to the shared sound). */
  sound?: string;
  /** Optional live unlock condition (omit for an achievement unlocked imperatively elsewhere). */
  trigger?: TriggerSpec;
}

/** The resolved achievement the UI consumes (asset filenames → URLs, trigger spec → selector). */
export interface AchievementDef {
  /** Stable id (the store key). */
  id: string;
  title: string;
  description: string;
  /** Resolved image URL shown on the Settings page (and the unlock toast). */
  icon: string;
  /** Resolved unlock-toast sound URL (undefined ⇒ the shared default). */
  sound?: string;
  /** Live unlock condition as a pure store selector (undefined ⇒ no live toast). */
  trigger?: (s: AppStore) => boolean;
}

// One JSON file per achievement, bundled at build time (mirrors data/roles, #1715).
const achievementModules = import.meta.glob<{ default: RawAchievement }>(
  "@data/achievements/*.json",
  { eager: true },
);
// Every image/audio asset as its URL, so a JSON `icon`/`sound` filename resolves without a per-asset
// import (the default export of an asset module is its URL — same as `import x from "…png"`). A
// RELATIVE glob (not the `@` alias) so it resolves identically under Vite and Vitest.
const assetUrls = import.meta.glob<string>(
  "../../../assets/*.{png,jpg,jpeg,svg,webp,mp3,wav,ogg}",
  { eager: true, import: "default" },
);

/** Resolve an asset filename (e.g. "x.png") to its built URL, or "" when absent. Matches on the
 *  basename so it's robust to `/` vs `\` in glob keys across platforms. */
function assetUrl(filename: string | undefined): string {
  if (!filename) return "";
  const hit = Object.entries(assetUrls).find(([path]) => path.split(/[\\/]/).pop() === filename);
  return hit?.[1] ?? "";
}

/** Compile a declarative trigger into a pure store selector. Fail-safe: a missing/non-numeric field
 *  or unknown op never fires, so a malformed JSON can't spuriously unlock an achievement. */
export function compileTrigger(t: TriggerSpec | undefined): ((s: AppStore) => boolean) | undefined {
  if (!t) return undefined;
  return (s) => {
    const v = (s as unknown as Record<string, unknown>)[t.field];
    if (typeof v !== "number") return false;
    switch (t.op) {
      case "gt":  return v > t.value;
      case "gte": return v >= t.value;
      case "lt":  return v < t.value;
      case "lte": return v <= t.value;
      case "eq":  return v === t.value;
      default:    return false;
    }
  };
}

/** Resolve a raw JSON achievement into the runtime {@link AchievementDef}. */
function resolveAchievement(raw: RawAchievement): AchievementDef {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    icon: assetUrl(raw.icon),
    sound: raw.sound ? assetUrl(raw.sound) : undefined,
    trigger: compileTrigger(raw.trigger),
  };
}

/** Every packaged achievement, sorted by filename for a stable order. */
export const ACHIEVEMENTS: AchievementDef[] = Object.entries(achievementModules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, m]) => resolveAchievement(m.default));

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
