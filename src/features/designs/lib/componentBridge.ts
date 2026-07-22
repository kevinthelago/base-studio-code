// The frontend ↔ component-library bridge (#2269/#2281). The library is a GLOBAL store, reached — from
// the UI AND from a live session's own shell — through the SAME `bsc ui …` CLI over the generic
// `bsc` bridge (#2114). Global store → every call passes `null` as the projectKey. This is the only
// place the components feature touches Tauri, so the pure model in `model.ts` stays React/Tauri-free.
//
// Two collections: components (`bsc ui …`) and kits (`bsc ui kit …`). Reads use `--full`
// (the complete objects the pane needs). `loadX` returns `null` when the bridge is unreachable (tests /
// web shell / an old bundled `bsc`) so the store keeps its seed rather than blanking it — NOT `bscJson`,
// whose degrade-to-`[]` would blank the seed.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { ComponentRecord, Kit, Role } from "./model";
import { ROLES } from "./model";

/** Load every component from the global store via `bsc ui list --full`; `null` when unreachable. */
export async function loadComponents(): Promise<ComponentRecord[] | null> {
  try {
    const out = await bsc(null, ["ui", "list", "--full"]);
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
        group: c.group, // #3048 — the kit-purpose partition; rides verbatim (never defaulted), like tech/style on a kit
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
        shapes: c.shapes,
        animations: c.animations, // #2942 — MOTION binding (the kit-animation names it plays); rides verbatim
        spec: c.spec, // #3569 — a page/layout node's renderable GeneralNode skeleton; rides verbatim so the host can render from the store
        seedHash: c.seedHash, // #2483 — must ride the allowlist or the refresh baseline is lost on write-through
      }));
  } catch {
    return null;
  }
}

/** Load every kit via `bsc ui kit list --full`; `null` when unreachable. */
export async function loadKits(): Promise<Kit[] | null> {
  try {
    const out = await bsc(null, ["ui", "kit", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<Kit>[];
    return (rows ?? [])
      .filter((k): k is Kit => typeof k.id === "string" && !!k.id && !!k.name)
      // tech/style (#2487) ride VERBATIM — an absent field must stay absent (never defaulted), so a
      // pre-#2487 copy still hashes to its recorded seedHash and the #2483 reconcile can refresh it.
      .map((k) => ({ id: k.id, name: k.name!, tech: k.tech, style: k.style, stack: k.stack ?? "", dot: k.dot ?? "var(--fg-muted)", animations: k.animations, builtin: k.builtin, seedHash: k.seedHash }));
  } catch {
    return null;
  }
}

/** Write-through a component upsert (`bsc ui set`, JSON on stdin). Fire-and-forget; never throws
 *  (an old bundled `bsc` without the `ui` store verbs (#2469) degrades to cache-only). */
export async function pushComponent(component: ComponentRecord): Promise<void> {
  try { await bscWrite(null, ["ui", "set"], component); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a component removal (`bsc ui remove <id>`). Never throws. */
export async function dropComponent(id: string): Promise<void> {
  try { await bscRun(null, ["ui", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit upsert (`bsc ui kit set`). Never throws. */
export async function pushKit(kit: Kit): Promise<void> {
  try { await bscWrite(null, ["ui", "kit", "set"], kit); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit removal (`bsc ui kit remove <id>`). Never throws. */
export async function dropKit(id: string): Promise<void> {
  try { await bscRun(null, ["ui", "kit", "remove", id]); } catch { /* store unreachable — cache-only */ }
}

/** Record a captured preview RUNTIME error to the durable log `bsc ui preview-errors` tails (#3165). The
 *  message (a stack trace) rides on the child's stdin. Fire-and-forget: never throws — an old bundled
 *  `bsc` without the verb just no-ops the observability (the in-pane error banner still shows). Makes a
 *  preview throw — otherwise only ephemeral React state — readable from a session's shell. */
export async function recordPreviewError(id: string, message: string): Promise<void> {
  try { await bsc(null, ["ui", "preview-error", id], message); } catch { /* bridge/binary absent — banner-only */ }
}
