// The frontend ↔ component-library bridge (#2269/#2281). The library is a GLOBAL store, reached — from
// the UI AND from a live session's own shell — through the SAME `bsc component …` CLI over the generic
// `bsc` bridge (#2114). Global store → every call passes `null` as the projectKey. This is the only
// place the components feature touches Tauri, so the pure model in `model.ts` stays React/Tauri-free.
//
// Two collections: components (`bsc component …`) and kits (`bsc component kit …`). Reads use `--full`
// (the complete objects the pane needs). `loadX` returns `null` when the bridge is unreachable (tests /
// web shell / an old bundled `bsc`) so the store keeps its seed rather than blanking it — NOT `bscJson`,
// whose degrade-to-`[]` would blank the seed.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { ComponentRecord, Kit, Role } from "./model";
import { ROLES } from "./model";

/** Load every component from the global store via `bsc component list --full`; `null` when unreachable. */
export async function loadComponents(): Promise<ComponentRecord[] | null> {
  try {
    const out = await bsc(null, ["component", "list", "--full"]);
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
        builtin: c.builtin,
        wraps: c.wraps,
        rules: c.rules,
      }));
  } catch {
    return null;
  }
}

/** Load every kit via `bsc component kit list --full`; `null` when unreachable. */
export async function loadKits(): Promise<Kit[] | null> {
  try {
    const out = await bsc(null, ["component", "kit", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<Kit>[];
    return (rows ?? [])
      .filter((k): k is Kit => typeof k.id === "string" && !!k.id && !!k.name)
      .map((k) => ({ id: k.id, name: k.name!, stack: k.stack ?? "", dot: k.dot ?? "var(--fg-muted)", builtin: k.builtin }));
  } catch {
    return null;
  }
}

/** Write-through a component upsert (`bsc component set`, JSON on stdin). Fire-and-forget; never throws
 *  (an old bundled `bsc` without the `component` subcommand degrades to cache-only). */
export async function pushComponent(component: ComponentRecord): Promise<void> {
  try { await bscWrite(null, ["component", "set"], component); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a component removal (`bsc component remove <id>`). Never throws. */
export async function dropComponent(id: string): Promise<void> {
  try { await bscRun(null, ["component", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit upsert (`bsc component kit set`). Never throws. */
export async function pushKit(kit: Kit): Promise<void> {
  try { await bscWrite(null, ["component", "kit", "set"], kit); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit removal (`bsc component kit remove <id>`). Never throws. */
export async function dropKit(id: string): Promise<void> {
  try { await bscRun(null, ["component", "kit", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
