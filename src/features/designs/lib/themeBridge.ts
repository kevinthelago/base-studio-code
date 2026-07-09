// The frontend ↔ theme-store bridge (#2488) — the kit-theme collection is a GLOBAL store reached,
// from the UI AND from a live session's own shell, through the SAME `bsc ui theme …` CLI over the
// generic `bsc` bridge (#2114). Mirrors componentBridge.ts: `loadThemes` returns `null` when the
// bridge is unreachable (tests / web shell / an old bundled `bsc`) so the slice keeps its packaged
// seed rather than blanking it; the writes are fire-and-forget.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { KitThemeRecord } from "./themes";
import type { VariantDef } from "@/shared/ui/kit";

/** Load every stored component-variant definition via `bsc ui variants` (#2569); `null` when the bridge
 *  is unreachable (an old bundled `bsc` without the verb) so the app keeps whatever it already applied.
 *  Defensive shape gate: a row must carry string `component`/`variant` and an object `tokens`. */
export async function loadVariants(): Promise<VariantDef[] | null> {
  try {
    const out = await bsc(null, ["ui", "variants"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<VariantDef>[];
    return (rows ?? []).filter(
      (v): v is VariantDef =>
        typeof v.component === "string" && typeof v.variant === "string" && !!v.tokens && typeof v.tokens === "object",
    );
  } catch {
    return null;
  }
}

/** Load every theme via `bsc ui theme list --full`; `null` when unreachable.
 *
 *  Defensive shape gate: a row must carry `id`, `label`, AND an object `vars`. An OLD bundled `bsc`
 *  (pre-#2488) ignores `--full` and prints the lean `{id, label, description}` projection — those
 *  var-less rows are dropped here, so the hydrate sees an empty store and re-seeds rather than
 *  caching themes whose override maps were lost. */
export async function loadThemes(): Promise<KitThemeRecord[] | null> {
  try {
    const out = await bsc(null, ["ui", "theme", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<KitThemeRecord>[];
    return (rows ?? [])
      .filter(
        (t): t is KitThemeRecord =>
          typeof t.id === "string" && !!t.id && typeof t.label === "string" &&
          !!t.vars && typeof t.vars === "object",
      )
      .map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description ?? "",
        // `base` is seed-relevant content and must ride WITHOUT normalizing (#2514 round-trip
        // contract): absent stays absent (never defaulted) so a base-less theme still hashes to its
        // stamp. Spread so the key is omitted entirely when the source row has no `base`.
        ...(t.base !== undefined ? { base: t.base } : {}),
        vars: t.vars,
        builtin: t.builtin,
        seedHash: t.seedHash, // #2483 — must ride or the refresh baseline is lost on write-through
      }));
  } catch {
    return null;
  }
}

/** Write-through a theme upsert (`bsc ui theme set`, JSON on stdin). Never throws (an old bundled
 *  `bsc` without the theme store verbs degrades to cache-only). */
export async function pushTheme(theme: KitThemeRecord): Promise<void> {
  try { await bscWrite(null, ["ui", "theme", "set"], theme); } catch { /* store unreachable — cache-only */ }
}

/** Write-through a theme removal (`bsc ui theme remove <id>`). Never throws. */
export async function dropTheme(id: string): Promise<void> {
  try { await bscRun(null, ["ui", "theme", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
