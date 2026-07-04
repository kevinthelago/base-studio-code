// The frontend ↔ component-library bridge (#2269). The library is a GLOBAL store, reached — from the UI
// AND from a live session's own shell — through the SAME `bsc component …` CLI over the generic `bsc`
// bridge (#2114). Global store → every call passes `null` as the projectKey. This is the only place the
// components feature touches Tauri, so the pure model in `model.ts` stays React/Tauri-free.
//
// The store crate/CLI doesn't exist yet, so `loadComponents` returns `null` (the bridge is unreachable)
// and the store keeps its typed seed. Wiring the real store later is exactly this one call — no caller
// changes: the pane already treats `loadComponents()` as its single data source.
import { bsc } from "@/shared/lib/core/bsc";
import type { ComponentRecord, Role } from "./model";
import { ROLES } from "./model";

/**
 * Load every component from the global store via `bsc component list --json`. Returns `null` when the
 * bridge is unreachable (no Tauri host — tests/web shell — or a bundled `bsc` without the `component`
 * subcommand, which is *every* build until the store lands) so the caller keeps its seeded library
 * rather than blanking it. NOT `bscJson` — its degrade-to-`[]` would blank the seed.
 */
export async function loadComponents(): Promise<ComponentRecord[] | null> {
  try {
    const out = await bsc(null, ["component", "list", "--json"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<ComponentRecord>[];
    // Defensive: keep only well-formed rows (id + name + kitId), defaulting the rest so an odd record
    // never crashes hydration.
    return (rows ?? [])
      .filter((c): c is ComponentRecord => typeof c.id === "string" && !!c.id && !!c.name && !!c.kitId)
      .map((c) => ({
        id: c.id,
        name: c.name!,
        kitId: c.kitId!,
        role: (ROLES.includes(c.role as Role) ? c.role : "primitive") as Role,
        version: c.version ?? "",
        used: typeof c.used === "number" ? c.used : 0,
        tags: c.tags ?? [],
        variants: c.variants?.length ? c.variants : ["default"],
        composes: c.composes ?? [],
        props: c.props ?? [],
        whenUse: c.whenUse ?? [],
        whenNot: c.whenNot ?? [],
        src: c.src ?? "",
        srcText: c.srcText ?? "",
      }));
  } catch {
    return null;
  }
}
