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

/**
 * Project one raw `bsc ui list --full` row into a full {@link ComponentRecord}, defaulting absent
 * optionals to their empty shape so an odd record never crashes hydration. Exported (#3606) so the
 * packaged SEED is assembled through the SAME projection — a seed record then equals `load(push(seed))`
 * by construction, satisfying the #2514 round-trip contract without hand-mirroring these defaults (the
 * server-stamped provenance the two copies differ by — `rev`/`updatedAt`/… — is excluded from the hash).
 */
export function projectComponent(c: Partial<ComponentRecord>): ComponentRecord {
  return {
    id: c.id!,
    // #3725: a suppression tombstone carries only `{id, suppressed}` — fall its name/kitId back to the id
    // so the projection stays total; the reconcile drops it before it's ever rendered anyway.
    name: c.name ?? c.id!,
    kitId: c.kitId ?? "",
    role: (ROLES.includes(c.role as Role) ? c.role : "primitive") as Role,
    // #3048 — the folder path; rides verbatim (never defaulted), like tech/style on a kit. Reads the
    // legacy `group` key too (#4107 slice B): the store holds records written under the old name, and
    // this projection is the ONE place a raw record becomes a Component, so the fallback belongs here
    // rather than scattered across every consumer.
    folder: (c as { folder?: string; group?: string }).folder ?? (c as { group?: string }).group,
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
    suppressed: c.suppressed, // #3725 — the tombstone marker; reconcile intercepts it, doctor skips it
    wraps: c.wraps,
    provides: c.provides, // #3660 — the platform specifier this component overrides; rides verbatim (loader reads it)
    rules: c.rules,
    shapes: c.shapes,
    animations: c.animations, // #2942 — MOTION binding (the kit-animation names it plays); rides verbatim
    // #3810 / #3878 — the node's ANALYTICS events and its TESTS, the other two manifests it carries as
    // data. They ride verbatim like `animations`: this projection is an ALLOWLIST, so a field missing here
    // is dropped on every hydrate, and the seed round-trip below (`seed === load(push(seed))`) would break
    // for any record carrying one. Both were declared as contracts before anything populated them, so the
    // gap was invisible until the inspector's Tests tab (#3884) went to read them.
    analytics: c.analytics,
    tests: c.tests,
    spec: c.spec, // #3569 — a page/layout node's renderable GeneralNode skeleton; rides verbatim so the host can render from the store
    seedHash: c.seedHash, // #2483 — must ride the allowlist or the refresh baseline is lost on write-through
    // #3164/#3568 — provenance + change history, surfaced by the inspector History tab. SERVER-MANAGED:
    // the Rust stamp boundary recomputes rev/stamps + history from the PRIOR stored record and discards
    // whatever rides back on a write-through, so passing them here is display-only (never authoritative).
    rev: c.rev,
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy,
    history: c.history,
  };
}

/** Load every component from the global store via `bsc ui list --full`; `null` when unreachable. */
export async function loadComponents(): Promise<ComponentRecord[] | null> {
  try {
    const out = await bsc(null, ["ui", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<ComponentRecord>[];
    // Defensive: keep only well-formed rows (id + name + kitId) — OR a suppression tombstone (#3725), which
    // carries only `{id, suppressed}` and must survive the filter so the reconcile can block the re-seed.
    return (rows ?? [])
      .filter((c): c is ComponentRecord => typeof c.id === "string" && !!c.id && (c.suppressed === true || (!!c.name && !!c.kitId)))
      .map(projectComponent);
  } catch {
    return null;
  }
}

/**
 * Load every component's GRAPH projection via `bsc ui list --graph` (#4072) — `null` when unreachable.
 *
 * The fast half of the Studio's two-phase hydration: 33 KB instead of `--full`'s 1.72 MB (77.6% of
 * which is `srcText` no node reads), so the page paints instead of blocking up to 8s.
 *
 * Every record is stamped `lite` — the projection's empty `srcText`/`props` are DEFAULTS, not values,
 * and consumers that need real source must wait for the full read rather than treat them as real.
 */
export async function loadComponentsGraph(): Promise<ComponentRecord[] | null> {
  try {
    const out = await bsc(null, ["ui", "list", "--graph"]);
    const rows = JSON.parse(out) as Partial<ComponentRecord>[];
    return rows.map((c) => ({ ...projectComponent(c), lite: true as const }));
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
      // A suppression tombstone (#3725, `{id, suppressed}`) survives the filter so the reconcile blocks the
      // kit's re-seed; its name falls back to the id.
      .filter((k): k is Kit => typeof k.id === "string" && !!k.id && (k.suppressed === true || !!k.name))
      // tech/style (#2487) ride VERBATIM — an absent field must stay absent (never defaulted), so a
      // pre-#2487 copy still hashes to its recorded seedHash and the #2483 reconcile can refresh it.
      .map((k) => ({ id: k.id, name: k.name ?? k.id!, tech: k.tech, style: k.style, stack: k.stack ?? "", dot: k.dot ?? "var(--fg-muted)", animations: k.animations, builtin: k.builtin, suppressed: k.suppressed, seedHash: k.seedHash }));
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
