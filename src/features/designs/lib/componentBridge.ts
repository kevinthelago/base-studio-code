// The frontend ↔ component-library bridge (#2269/#2281). The library is a GLOBAL store, reached — from
// the UI AND from a live session's own shell — through the SAME `bsc ui …` CLI over the generic
// `bsc` bridge (#2114). Global store → every call passes `null` as the projectKey. This is the only
// place the components feature touches Tauri, so the pure model in `model.ts` stays React/Tauri-free.
//
// Two collections: components (`bsc ui …`) and kits (`bsc ui kit …`). Reads use `--full`
// (the complete objects the pane needs). `loadX` returns `null` when the bridge is unreachable (tests /
// web shell / an old bundled `bsc`) so the store keeps its seed rather than blanking it — NOT `bscJson`,
// whose degrade-to-`[]` would blank the seed.
import { bsc, bscJson, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import { log } from "@/shared/lib/core/log";
import type { ComponentRecord, Kit, Role } from "@/features/designs/lib/model";
import type { ComponentBuildStatus, RuntimeStateCategory } from "@/features/designs/lib/componentScan";
import { ROLES } from "@/features/designs/lib/model";

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
    folder: (c as { folder?: string }).folder,
    // The OWNERSHIP axis — which feature owns this record (`the-ownership-axis-is-feature-on-both-graphs`).
    // Rides verbatim beside `folder`, and MUST: a field missing from this allow-list is dropped on every
    // hydrate and then on write-back, which is how request #63 destroyed 38 records. It is also what the
    // ownership gate reads, so losing it here would make that rule silently see less.
    feature: (c as { feature?: string }).feature,
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
    // #a-tombstone-can-name-what-superseded-it — WHAT replaced a retired builtin. It MUST ride the
    // projection, not merely be stored: this projection is what the app pushes back with `--replace`, so
    // a field it does not model is silently dropped on write-back. That is precisely how request #63
    // destroyed 38 records, and it would be a especially poor failure here — the tombstone's entire
    // purpose is to be the durable fact that outlives every reseed.
    supersededBy: c.supersededBy,
    wraps: c.wraps,
    provides: c.provides, // #3660 — the platform specifier this component overrides; rides verbatim (loader reads it)
    // `record-src-reconcile` — WHY this record deliberately differs from its `src` file. Must ride this
    // ALLOWLIST for the same reason `analytics`/`tests` do: a field missing here is dropped on every
    // hydrate, and the seed round-trip (`seed === load(push(seed))`) then breaks for every record carrying
    // one — which would be all 70 annotated records, each mis-hashing against its stamp forever.
    srcDivergence: c.srcDivergence,
    srcRetired: c.srcRetired, // `record-src-reconcile` — the file this record superseded; same allowlist rule
    pageKind: c.pageKind, // shadow-catalogue-guard-over-reaches — app screen vs kit composition; same allowlist rule
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

/**
 * The library as a NAME INDEX — enough to answer "does this id/name exist, and in which kit", and
 * nothing more. `null` when either read is unreachable.
 *
 * Exists because the expensive read cannot be raced. `hydrateComponents` BLOCKS THE MAIN THREAD (the
 * `--full` read plus its reconcile), so a `setTimeout` bound around it cannot fire until the thing it
 * bounds has already finished — measured on the running app: a miss took 5.13s, and a `bsc navigate
 * show` fired 1.0s into it took 8.0s and timed out, because the app answered nothing at all for the
 * duration. The answer is to not pay the expensive read to decide a question the cheap one settles:
 *
 * | read | bytes |
 * |---|---|
 * | this (`ui list --graph` + `ui kit list --full`) | ~80 KB |
 * | `hydrateComponents` (`ui list --full` + reconcile) | 5.9 MB |
 *
 * DELIBERATELY NOT WRITTEN INTO THE STORE. The projection carries no `srcText`, and setting it on a warm
 * store makes every `GraphComponent` go real → "" → real, which unmounts each page's subtree and
 * recompiles it — the remount `hydrateComponents` phase 1 guards against by running only on a cold
 * store. This is a lookup, so it stays a value.
 */
export async function readLibraryIndex(): Promise<{ components: ComponentRecord[]; kits: Kit[] } | null> {
  const [components, kits] = await Promise.all([loadComponentsGraph(), loadKits()]);
  return components && kits ? { components, kits } : null;
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
 *  (an old bundled `bsc` without the `ui` store verbs (#2469) degrades to cache-only).
 *
 *  `--replace` is REQUIRED here (#4197). `bsc ui set` now MERGES — a partial write preserves what it
 *  omits, so a fleet worker editing one field can no longer delete the rest of a record whose source
 *  file is gone. The app is the opposite case: it holds the WHOLE record, and `reconcileSeed`'s
 *  seed-authoritative reset (#3723) depends on the store copy being overwritten field-for-field. Under a
 *  merge a store-only field would survive every reset, its content hash would stay off the seed's, and
 *  the reconcile would re-fire forever instead of converging. */
export async function pushComponent(
  component: ComponentRecord,
  opts?: { ifVersion?: number },
): Promise<void> {
  // A LITE RECORD IS NEVER A WRITE PAYLOAD (#a-lite-record-must-never-be-written-back).
  //
  // `loadComponentsGraph` (the `--graph` read, #4072) returns records whose `srcText`, `props`, `tags`,
  // `version`, `used`, `variants`, `whenUse` and `whenNot` are DEFAULTS rather than values — that is the
  // whole point of it (33KB instead of 1.72MB, so the Studio paints instead of blocking ~8s). They land
  // in the SAME `components` array every writer reads, and with `--replace` a push of one overwrites real
  // data with those defaults.
  //
  // That is not hypothetical: on 2026-08-14 at 17:36:50-51Z, one second after an app boot, THIRTY-EIGHT
  // records took exactly this write — 34 replaced by smaller content, `ui-tree` losing 6,887 characters —
  // and `glance-node`'s change entry names `srcText` plus precisely those six defaulted fields. Designer
  // request #63.
  //
  // The rev guard below does NOT cover it: those writes were not stale (the store had not moved), so they
  // passed. Lossy is not stale, which is why the #61 fix did not prevent #63.
  //
  // Guarded HERE, at the bridge, rather than at each caller — so it holds for the converge loop,
  // `setComponent`, `importKit`, and any path added later.
  if (component.lite) {
    log.warn(
      `ui-bridge: refused to write "${component.id}" — it is a LITE record (graph projection); its fields are defaults, not values`,
      "ui-bridge",
    );
    return;
  }
  const args = ["ui", "set", "--replace"];
  // OPTIMISTIC CONCURRENCY (#a-stale-app-copy-overwrites-a-designer-edit). Two independent writers share
  // this store — the app, and out-of-band `bsc ui set` sessions — so last-write-wins means whoever writes
  // second wins regardless of what they knew. A designer's `srcText` fix (rev8) was destroyed 23 minutes
  // later by a converge push carrying the copy the app had read BEFORE it (rev9), with no notice to
  // anyone; it was found only because the render error came back.
  //
  // `--if-version` names the rev this write is BASED on and the store refuses if it has moved. The guard
  // already existed in `bsc ui set`; nothing was sending it. Passed only where the caller can name the
  // rev it actually READ — an unguarded call still behaves exactly as before.
  if (typeof opts?.ifVersion === "number") args.push("--if-version", String(opts.ifVersion));
  try {
    await bscWrite(null, args, component);
  } catch (e) {
    // NOT silent. The old bare `catch {}` is what made this class invisible: a refused write and an
    // unreachable store were the same non-event, so "my edit vanished" had no counterpart in any log.
    // Still never throws — a write-through failure must not break the caller's render.
    log.warn(`ui-bridge: "${component.id}" not written: ${String(e).slice(0, 200)}`, "ui-bridge");
  }
}
/** Write-through JUST the seed stamp on an existing record (#4207) — a MERGING `bsc ui set`, which is
 *  the whole point: this is the one component write whose input came from READING the store, so a
 *  `--replace` would push the bridge PROJECTION back over the stored record and silently drop any field
 *  the projection does not carry. `pushComponent`'s `--replace` is correct for its case (the app holds
 *  the whole record, authored from the seed) and wrong for this one. Never throws. */
export async function stampComponent(id: string, seedHash: string): Promise<void> {
  try { await bscWrite(null, ["ui", "set"], { id, builtin: true, seedHash }); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a component removal (`bsc ui remove <id>`). Never throws. */
export async function dropComponent(id: string): Promise<void> {
  try { await bscRun(null, ["ui", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit upsert (`bsc ui kit set`). Never throws. `--replace` for the same reason
 *  `pushComponent` needs it (#4197) — the app holds the whole record and the kit seed reconcile must be
 *  able to force a diverged copy back.
 *
 *  NO LITE GUARD NEEDED here, and that is a fact about the reads rather than an oversight
 *  (#a-lite-record-must-never-be-written-back): `loadKits` only ever reads `--full`. There is no
 *  `--graph` projection for kits, so a kit record is never a bag of defaults the way a lite component is.
 *  If a lean kit read is ever added, this needs the same guard `pushComponent` has. */
export async function pushKit(kit: Kit): Promise<void> {
  try { await bscWrite(null, ["ui", "kit", "set", "--replace"], kit); } catch { /* store unreachable — cache-only */ }
}
/** Write-through a kit removal (`bsc ui kit remove <id>`). Never throws. */
export async function dropKit(id: string): Promise<void> {
  try { await bscRun(null, ["ui", "kit", "remove", id]); } catch { /* store unreachable — cache-only */ }
}

/** One cached scan outcome, as the durable store holds it. `status`/`stateBlanks` ride VERBATIM — the
 *  store is a courier for the frontend's own shapes, so there is no second definition to drift. */
export interface CachedScan {
  sig: string;
  status: ComponentBuildStatus;
  stateBlanks: RuntimeStateCategory[];
}

/**
 * Read the durable scan cache (`bsc ui scan-cache`, #the-component-scan-remembers-what-it-already-built).
 *
 * Empty on ANY failure — no bridge, an old binary, malformed JSON. That is the safe direction and the
 * whole safety argument for this cache: an empty read makes the sweep scan everything, which is exactly
 * what it did before the cache existed. It may only ever save work, never withhold a scan, because a
 * withheld scan leaves a stale badge on a component that is actually broken.
 */
export async function loadScanCache(): Promise<Record<string, CachedScan>> {
  try {
    const out = await bsc(null, ["ui", "scan-cache", "get"]);
    const parsed = JSON.parse(out.trim() || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rows: Record<string, CachedScan> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<CachedScan>;
      // A row without a signature can never be a hit (the sig is half the key), so drop it here rather
      // than let it look like a valid entry that simply never matches.
      if (!e || typeof e.sig !== "string" || !e.sig || !e.status) continue;
      rows[id] = { sig: e.sig, status: e.status, stateBlanks: Array.isArray(e.stateBlanks) ? e.stateBlanks : [] };
    }
    return rows;
  } catch {
    return {};
  }
}

/** Merge scan outcomes into the durable cache (`bsc ui scan-cache put`). Fire-and-forget: a failed write
 *  costs a re-scan next visit, which is the same thing that happened before the cache existed. */
export async function saveScanCache(entries: Record<string, CachedScan>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  try { await bsc(null, ["ui", "scan-cache", "put"], JSON.stringify(entries)); } catch { /* re-scan next visit */ }
}

/** What this process believes is CURRENTLY recorded in the durable preview-error log: id → the last
 *  message written for it. Module-level so every preview frame shares one view.
 *
 *  It exists to answer "does this id hold an error?" without paying a process to ask. Reporting spawned
 *  per failure and clearing spawned per SUCCESSFUL render, so a healthy Studio paid ~39ms of process
 *  start for every component that rendered fine — measured at 590 spawns / 251.9s in one session, the
 *  fourth-largest cost in the app and pure overhead (#a-broken-preview-costs-a-process-spawn-to-report).
 *
 *  Worse, it AMPLIFIED a breakage: a record sweep breaks previews, broken previews report, reports spawn,
 *  spawns saturate the invoke queue, and the Studio rendering those previews gets slower. Cost that
 *  scales with how broken things are is exactly backwards. */
const recordedErrors = new Map<string, string>();

/** Seeded ONCE from the durable log, because the map starts empty and the log does not.
 *
 *  Without this, a fresh boot believes nothing is recorded, so `clearPreviewError` skips every id and a
 *  component fixed between sessions keeps a stale finding forever — the precise failure #45/#60 added
 *  clearing to fix. One read replaces the N clear-spawns it makes unnecessary, so it is cheaper than the
 *  behaviour it preserves. A failed read leaves the map empty and simply restores the old spawn-always
 *  behaviour rather than losing a clear. */
let seedPromise: Promise<void> | null = null;
/** False once the seed read failed: the map is then not a trustworthy answer to "does this id hold an
 *  error?", so `clearPreviewError` stops taking the shortcut and spawns as it always did. Skipping
 *  instead would silently drop clears — and the failure modes are not symmetric. A missing clear leaves
 *  `bsc ui doctor` reporting a fault that a live preview disproves (#45/#60); a redundant clear just
 *  costs a process that `bsc` no-ops. Pay the process. */
let bookkeepingReliable = true;
function seedRecordedErrors(): Promise<void> {
  // The promise is cached, not a boolean: several frames mount at once and would otherwise each start
  // their own seed read while the first was still in flight.
  seedPromise ??= (async () => {
    const rows = await bscJson<{ id: string; message: string }[]>(
      null,
      ["ui", "preview-errors", "-n", "500"],
      [],
    );
    for (const r of rows ?? []) if (r?.id) recordedErrors.set(r.id, r.message ?? "");
  })().catch(() => { bookkeepingReliable = false; });
  return seedPromise;
}

/** Record a captured preview RUNTIME error to the durable log `bsc ui preview-errors` tails (#3165). The
 *  message (a stack trace) rides on the child's stdin. Fire-and-forget: never throws — an old bundled
 *  `bsc` without the verb just no-ops the observability (the in-pane error banner still shows). Makes a
 *  preview throw — otherwise only ephemeral React state — readable from a session's shell. */
export async function recordPreviewError(id: string, message: string): Promise<void> {
  await seedRecordedErrors();
  // The SAME failure, re-reported, is the common case rather than the exception: a broken preview
  // re-renders, and 149 of 200 errors in one measured hour were byte-identical. Writing it again buys
  // nothing — the log already says so — and costs a process.
  if (recordedErrors.get(id) === message) return;
  recordedErrors.set(id, message);
  try { await bsc(null, ["ui", "preview-error", id], message); } catch { /* bridge/binary absent — banner-only */ }
}

/**
 * Clear `id`'s recorded preview error because its preview just RENDERED (#45/#60).
 *
 * The missing half of {@link recordPreviewError}. Editing a component clears its error (#43) and so does
 * `bsc ui preview-error clear`, but nothing did when the preview simply started working — so a component
 * fixed by a change ELSEWHERE (a shared dependency, or a resolver bug in the preview itself) kept its
 * finding forever, and `bsc ui doctor` reported a failure a live `bsc shot preview` disproved.
 *
 * A successful render is the strongest evidence available that the recorded error is stale: it means the
 * component built AND ran. Fire-and-forget like its sibling — observability must never break a preview —
 * and already a no-op in `bsc` when the id holds no error, so a healthy component writes nothing.
 */
export async function clearPreviewError(id: string): Promise<void> {
  await seedRecordedErrors();
  // A HEALTHY component must not cost a process. `bsc` already no-ops a clear for an id holding no
  // error — but only after paying ~39ms of process start to find that out, and the overwhelmingly
  // common case in a working Studio is exactly that: every successful render asked. Knowing what is
  // recorded makes the question answerable here, for free.
  if (bookkeepingReliable && !recordedErrors.has(id)) return;
  recordedErrors.delete(id);
  try { await bsc(null, ["ui", "preview-error", "clear", id]); } catch { /* bridge/binary absent — no-op */ }
}
