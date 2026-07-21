// The kit-theme collection's pure domain (#2488) — the store-record shape, the packaged seed, and the
// reconcile/ordering helpers. Themes became a designer-writable store collection (`bsc ui theme
// set/remove` over `~/.base-studio-code/themes/`): the PACKAGED registry (`@data/ui/themes.json`, via
// `KIT_THEMES`) seeds it, and the #2483 hash-based `reconcileSeed` keeps the built-ins fresh across
// releases while never clobbering a designer-edited copy. React/Tauri-free (the bridge lives in
// themeBridge.ts) → unit-testable.

import { KIT_THEMES, type KitTheme } from "@/shared/ui/kit";
import { reconcileSeed, stampSeedHash, type SeedReconcile } from "./seedRefresh";

/** A theme as the STORE holds it: the packaged shape plus the seed-tracking provenance (#2483). */
export interface KitThemeRecord extends KitTheme {
  /** A packaged built-in. Absent/false ⇒ designer/user-authored (never touched by the reconcile). */
  builtin?: boolean;
  /** The content hash stamped when this copy was seeded (#2483). */
  seedHash?: string;
}

/** The packaged built-in themes as seed records — `builtin` + `seedHash` stamped at assembly time
 *  (the packaged JSON never bakes them in), mirroring `makeBuiltinKits`. */
export const SEED_THEMES: KitThemeRecord[] = KIT_THEMES.map((t) => stampSeedHash({ ...t, builtin: true }));

/** Reconcile the store's loaded themes with the packaged built-ins (#2483 — the full verdict table
 *  lives on {@link reconcileSeed}): a PRISTINE built-in copy tracks the seed (refreshed/deleted), a
 *  designer-EDITED one is kept (with a notice when the seed diverged), user-authored themes are never
 *  touched, and missing built-ins are re-seeded. `hydrateThemes` applies the pushes/drops. */
export function reconcileThemes(loaded: KitThemeRecord[]): SeedReconcile<KitThemeRecord> {
  return reconcileSeed(loaded, SEED_THEMES, "theme");
}

/** Deterministic display order for the pickers: the packaged registry order first (`default` leads),
 *  then every other (designer-authored) theme sorted by label. The store's on-disk listing order is
 *  filesystem-dependent, so the hydrate normalizes here. */
export function orderThemes(records: KitThemeRecord[]): KitThemeRecord[] {
  const seedRank = new Map(KIT_THEMES.map((t, i) => [t.id, i]));
  const packaged = records
    .filter((r) => seedRank.has(r.id))
    .sort((a, b) => seedRank.get(a.id)! - seedRank.get(b.id)!);
  const authored = records
    .filter((r) => !seedRank.has(r.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...packaged, ...authored];
}

/** The bucket a theme with no `tech` falls into (#2749). `tech` is required, but a corrupt persisted
 *  copy must never crash the page — it groups here, always ordered last. */
export const OTHER_GROUP = "other";

/** A design-group section on the Themes page (#2749): one `tech` group and the themes under it,
 *  mirroring how the Designs rail groups kits by their `tech` axis. */
export interface ThemeGroup {
  /** The design-group slug (`react`, …); {@link OTHER_GROUP} for a theme with no `tech`. */
  tech: string;
  /** The header label (the raw slug — the gallery uppercases it like the Designs `ds-grouphead`). */
  label: string;
  themes: KitThemeRecord[];
}

/** Group themes by their design group (#2749) for the grouped Themes page: one section per `tech`,
 *  themes kept in {@link orderThemes} order within a group, groups ordered by first appearance with
 *  the missing-`tech` bucket forced last. Pure → unit-tested. */
export function groupThemes(records: KitThemeRecord[]): ThemeGroup[] {
  const byTech = new Map<string, KitThemeRecord[]>();
  for (const t of orderThemes(records)) {
    const tech = (t.tech ?? "").trim() || OTHER_GROUP;
    const arr = byTech.get(tech);
    if (arr) arr.push(t);
    else byTech.set(tech, [t]);
  }
  const other = byTech.get(OTHER_GROUP);
  if (other && byTech.size > 1) {
    byTech.delete(OTHER_GROUP);
    byTech.set(OTHER_GROUP, other); // force the defensive bucket last
  }
  return [...byTech].map(([tech, themes]) => ({ tech, label: tech, themes }));
}
