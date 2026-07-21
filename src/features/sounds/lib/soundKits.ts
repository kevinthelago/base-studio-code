// The Sounds pillar's BUILT-IN kits (#3080) — loaded from the embedded seed JSON under
// `src-tauri/data/sounds/` (`@data` alias), the ONE source of truth. The durable `bsc-sound` store
// hydrates from these on first run; this replaces the former hardcoded TS seed (soundSeeds.ts), per the
// golden rule (seeds live in data/, the store is the source at runtime). Same `import.meta.glob` pattern
// as the personas + component built-ins.
import type { SoundKit } from "./soundDescriptor";

const kitModules = import.meta.glob<{ default: SoundKit }>("@data/sounds/*.json", { eager: true });

/** Every packaged sound kit, ordered by id for determinism. */
export const BUILTIN_KITS: SoundKit[] = Object.values(kitModules)
  .map((m) => m.default)
  .sort((a, b) => a.id.localeCompare(b.id));

/** The default starter kit — the first built-in (currently "Signal"). Kept for call sites that want one
 *  concrete kit without threading the whole list. */
export const STARTER_KIT: SoundKit = BUILTIN_KITS[0];

/**
 * Union the durable store rows with the packaged built-ins: built-ins first (stable order), a STORED kit
 * WINS for a shared id (user edits override the seed), and any built-in the store lacks is returned in
 * `toSeed` so the caller can push it back — first-run seeding. Pure.
 */
export function mergeKits(
  stored: SoundKit[],
  builtins: SoundKit[] = BUILTIN_KITS,
): { kits: SoundKit[]; toSeed: SoundKit[] } {
  const storedById = new Map(stored.map((k) => [k.id, k]));
  const builtinIds = new Set(builtins.map((b) => b.id));
  const toSeed = builtins.filter((b) => !storedById.has(b.id));
  const kits: SoundKit[] = [
    ...builtins.map((b) => storedById.get(b.id) ?? b), // built-ins first; a stored kit wins for its id
    ...stored.filter((s) => !builtinIds.has(s.id)),     // then any store-only kits
  ];
  return { kits, toSeed };
}
