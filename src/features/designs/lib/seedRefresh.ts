// Hash-based built-in seed refresh (#2483) — the pure decision spine that replaced the frozen
// seed-and-keep reconcile. The store wins ONLY for records the user actually edited; a pristine
// built-in copy tracks the packaged seed release-to-release (the react-ui kit is GENERATED from the
// app's own source, so every release drifts the seed).
//
// The mechanism: every packaged built-in carries a `seedHash` — a small content hash of its
// seed-relevant fields, stamped at seed-assembly time (`makeBuiltinKits`). A store copy whose
// current content still hashes to its recorded `seedHash` is UNMODIFIED (safe to refresh/delete);
// one that no longer does was edited by the user (kept, with an "updated upstream" notice when the
// seed moved too).
//
// Hash exclusions (the "volatile" set, `SEED_HASH_EXCLUDED`):
//   - `seedHash`  — the stamp itself can never feed its own hash.
//   - `builtin`   — provenance, not content (stamped on assembly AND carried by the bridge).
//   - `used`      — the runtime reuse counter; it drifts without a user edit.
//   - `rev` / `updatedAt` / `updatedBy` / `history` (#3606) — SERVER-MANAGED provenance the Rust stamp
//     boundary writes on every `bsc ui set` (a component write-through stamps them). `componentBridge`
//     projects them for the inspector's History tab, so they ride into the loaded record — but they are
//     NOT seed content, so hashing them would make a pristine SEEDED component (pushed → stamped → loaded
//     with a fresh `rev`) mis-hash as user-modified forever. Kits/themes never projected them, so this is
//     the component-seed case the empty `SEED_COMPONENTS` had never exercised.
// Everything else on the record IS seed content — a change to any other field is a user edit (store
// copy) or a new release (seed copy).
//
// THE ROUND-TRIP CONTRACT (#2514). A stamp is only meaningful if the record's seed-relevant content
// survives the push→store→load round-trip byte-for-byte: `bsc ui … set` persists the JSON verbatim
// (key order aside), `… list --full` returns it verbatim, and the bridge projections
// (componentBridge/themeBridge `loadX`) must carry every seed-relevant field WITHOUT normalizing it —
// an absent optional field must stay absent (never defaulted to `""`/`[]`), or the reloaded copy
// hashes differently from its stamp and the reconcile mis-judges a pristine record as user-modified
// forever. This invariant is EXECUTED, not assumed: `seedRoundTrip.test.ts` pushes every packaged
// seed record through the real bridge mapping over a faithful store emulation and asserts the
// reloaded content still hashes to its stamp.
//
// Defense in depth for a stamp that rots anyway (an older hasher, a byte-mangling round-trip in some
// past build): a mismatched `builtin` copy gets a second chance against the CURRENT seed — content
// identical to the seed ⇒ the stamp itself was wrong, re-judged pristine and re-stamped (see the
// verdict table on `reconcileSeed`). Silent keep-forever is impossible: every KEEP of a diverged
// copy surfaces a notice.
//
// Deliberately GENERIC over `{ id, name, builtin?, seedHash? }` (components AND kits today) so the
// same helper can be extracted for the other seed-and-keep stores (personas, orgs, blueprints) later
// — it has no component-specific knowledge beyond the volatile-field list above.

/** The minimum shape the reconcile needs; components, kits, and themes (#2488) all satisfy it. */
export interface SeedRecord {
  id: string;
  /** Display name for the notices — components/kits carry `name`; themes carry `label` instead. */
  name?: string;
  /** Theme display name (#2488) — the notices fall back name → label → id. */
  label?: string;
  /** A packaged built-in. Absent/false ⇒ user-authored (never touched by the reconcile). */
  builtin?: boolean;
  /** A SUPPRESSION tombstone (#3725) — `true` marks this id as a PERMANENTLY removed packaged builtin.
   *  The reconcile skips it (not a record to render) and its presence blocks the seed from re-adding it. */
  suppressed?: boolean;
  /** The content hash stamped when this copy was seeded (#2483). Absent ⇒ a legacy pre-#2483 copy. */
  seedHash?: string;
}

/** The display name a notice carries: `name` (components/kits) → `label` (themes) → the id. */
function displayName(rec: SeedRecord): string {
  return rec.name ?? rec.label ?? rec.id;
}

/** Fields excluded from the seed hash — see the module doc for why each. */
export const SEED_HASH_EXCLUDED = ["seedHash", "builtin", "used", "rev", "updatedAt", "updatedBy", "history"] as const;

/** Deterministic JSON: keys sorted recursively, `undefined` properties dropped (so an absent
 *  optional field and an explicitly-undefined one hash identically). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** FNV-1a 32-bit over the text, as 8 hex digits. Not cryptographic — a drift detector, not a
 *  security boundary (the store is the user's own local files). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The seed hash of a record's CURRENT content (volatile fields excluded). */
export function seedHashOf(record: SeedRecord): string {
  const rest: Record<string, unknown> = { ...record };
  for (const k of SEED_HASH_EXCLUDED) delete rest[k];
  return fnv1a(stableStringify(rest));
}

/** Stamp a record with its own content hash — what `makeBuiltinKits` applies to every packaged
 *  built-in at seed-assembly time (the packaged JSON files do NOT bake the field in). */
export function stampSeedHash<T extends SeedRecord>(record: T): T {
  return { ...record, seedHash: seedHashOf(record) };
}

/** What a notice is about. */
export type SeedNoticeType = "component" | "kit" | "theme";

/** A reconcile outcome the user should see (the propagation-surface record, #2483). */
export interface SeedNotice {
  /** `updated-upstream`: the packaged built-in changed but the user's customized copy was kept.
   *  `orphaned`: the built-in left the seed but the user's customized copy was kept.
   *  `reset-to-seed`: a SEED-AUTHORITATIVE record (an import-based page spec, #3723) had a diverged
   *  store copy FORCED back to the packaged seed. The store never wins for these, so a divergence is a
   *  bug (a designer self-contained it for the preview sandbox), not a user edit — surfaced, not silent.
   *  `unstamped`: the store copy carries NO `builtin` flag but a packaged seed of that id EXISTS, so the
   *  reconcile treats it as user-authored and never refreshes it — while the app renders it (#4216). The
   *  record is left exactly as it is (changing 44 pages at once is not a reconcile's call); this makes
   *  the state visible so it can be judged per record. */
  kind: "updated-upstream" | "orphaned" | "reset-to-seed" | "unstamped";
  type: SeedNoticeType;
  id: string;
  name: string;
}

/** The reconcile verdicts: the final collection + the write-through work to converge the store. */
export interface SeedReconcile<T extends SeedRecord> {
  /** The reconciled collection (loaded order, refreshed in place; missing seeds appended). */
  records: T[];
  /** Records to write through (`bsc ui set` / `kit set`): refreshed + newly-added built-ins. */
  pushes: T[];
  /** Ids to remove from the store (`bsc ui remove` / `kit remove`): deleted built-ins. */
  drops: string[];
  /** The "kept but diverged" outcomes to surface. */
  notices: SeedNotice[];
}

/**
 * Reconcile the store's loaded records with the packaged seed (#2483). Verdict table — for a loaded
 * record with `builtin: true` ("modified" = its content no longer hashes to its recorded `seedHash`;
 * a record with NO `seedHash` is a legacy pre-#2483 copy, grandfathered as UNMODIFIED — all three
 * real rot incidents were pristine copies, so this heals every existing install once):
 *
 * | in seed? | modified? | seed moved (`seed.seedHash !== record.seedHash`)? | verdict |
 * |---|---|---|---|
 * | yes | no  | yes (incl. legacy no-hash) | REFRESH — take the new seed copy, push it |
 * | yes | no  | no                         | keep the store copy (already current) |
 * | yes | yes | yes (incl. legacy… n/a)    | KEEP + `updated-upstream` notice |
 * | yes | yes | no                         | keep (customized, seed unchanged) |
 * | no  | no  |                            | DELETE (drop from store) |
 * | no  | yes |                            | KEEP + `orphaned` notice |
 *
 * Tolerant re-stamp (#2514): before the "modified" KEEP fires for an in-seed record, its content is
 * compared against the CURRENT seed copy's content hash. Identical content ⇒ only the recorded stamp
 * is wrong (an older hasher / a byte-mangling round-trip in a past build stamped it) — the record is
 * re-judged PRISTINE and refreshed to the seed copy (same content, corrected stamp), no notice. A
 * retired record with a wrong stamp has no seed copy to compare against, so it stays on the
 * conservative KEEP + `orphaned` branch — kept, but never silently (the notice is the surface).
 *
 * Non-builtin (user-authored) loaded records pass through untouched, always. Seed records the store
 * lacks are appended + pushed (the original seed-and-keep add).
 *
 * @param loaded the store's records (from the bridge).
 * @param seed   the packaged built-ins, seedHash-stamped (`makeBuiltinKits`).
 * @param type   what the records are (for the notices).
 * @param opts   `seedAuthoritative` (#3723) — records for which the SEED wins unconditionally (an
 *               import-based page spec): a diverged store copy is a bug, not a user edit, so it is
 *               FORCED back to the seed with a `reset-to-seed` notice instead of the customized-KEEP the
 *               verdict table above would apply. Records it doesn't match keep the normal verdicts.
 */
export function reconcileSeed<T extends SeedRecord>(
  loaded: T[],
  seed: T[],
  type: SeedNoticeType,
  opts?: { seedAuthoritative?: (rec: T) => boolean },
): SeedReconcile<T> {
  const seedById = new Map(seed.map((s) => [s.id, s]));
  const records: T[] = [];
  const pushes: T[] = [];
  const drops: string[] = [];
  const notices: SeedNotice[] = [];

  for (const rec of loaded) {
    // #3725: a SUPPRESSION tombstone — a marker that a packaged builtin of this id is permanently removed.
    // It is not a record to render (skip it from `records`), and its presence in `loaded` (hence `have`
    // below) makes the re-seed step SKIP that id, so the builtin never comes back. It stays in the store
    // (never dropped) so the block persists; `unsuppress` (remove it) lets the next hydrate re-seed.
    if (rec.suppressed) continue;
    if (!rec.builtin) {
      // #4216: an unstamped record with a packaged seed of the same id is NOT user-authored — it is a
      // built-in whose stamp was lost (a pre-#4197 partial `bsc ui set` dropped `builtin`/`seedHash`).
      // The reconcile has been skipping it ever since, so it never refreshes — while the app renders it,
      // because this branch pushes the store copy straight into `records`. Say so.
      //
      // Behaviour is deliberately UNCHANGED: the store copy still wins. Deciding which side is right is
      // a per-record judgement (the drift runs both ways — some store copies are far smaller than their
      // seed, some far larger), and a reconcile that silently replaced 44 pages would be the worse bug.
      if (seedById.has(rec.id)) {
        notices.push({ kind: "unstamped", type, id: rec.id, name: displayName(rec) });
      }
      records.push(rec); // user-authored (or unstamped) — never touched
      continue;
    }
    const seeded = seedById.get(rec.id);
    // Legacy pre-#2483 copies (no seedHash) are grandfathered as unmodified.
    const contentHash = rec.seedHash === undefined ? undefined : seedHashOf(rec);
    let modified = contentHash !== undefined && contentHash !== rec.seedHash;
    if (seeded) {
      const seedContentHash = seeded.seedHash ?? seedHashOf(seeded);
      // Seed-authoritative records (#3723): the store NEVER wins. A store copy whose CONTENT differs
      // from the seed is a divergence bug — e.g. a designer self-contained an import-based page spec so
      // it would render in the preview sandbox, which then silently shadowed the real page (#3658 →
      // #3723) — not a user edit. Force the seed copy back (push it), surfaced via a `reset-to-seed`
      // notice so the override is never silent. A copy already matching the seed is left untouched.
      if (opts?.seedAuthoritative?.(rec)) {
        if (seedHashOf(rec) !== seedContentHash) {
          records.push(seeded);
          pushes.push(seeded);
          notices.push({ kind: "reset-to-seed", type, id: rec.id, name: displayName(rec) });
        } else {
          records.push(rec); // already matches the seed
        }
        continue;
      }
      // Tolerant re-stamp (#2514): content identical to the CURRENT seed ⇒ the recorded stamp is the
      // broken part, not the content — re-judge pristine (the refresh below adopts the seed copy,
      // which is the same content with the corrected stamp).
      if (modified && contentHash === seedContentHash) modified = false;
      const seedMoved = seedContentHash !== rec.seedHash;
      if (!modified && seedMoved) {
        records.push(seeded); // pristine + stale → refresh to the new seed copy
        pushes.push(seeded);
      } else {
        records.push(rec); // current, or customized (store wins)
        if (modified && seedMoved) notices.push({ kind: "updated-upstream", type, id: rec.id, name: displayName(rec) });
      }
    } else if (modified) {
      records.push(rec); // customized copy of a retired built-in — keep, but say so
      notices.push({ kind: "orphaned", type, id: rec.id, name: displayName(rec) });
    } else {
      drops.push(rec.id); // pristine copy of a retired built-in → delete
    }
  }

  // Built-ins the store lacks entirely (first run / newly packaged) — append + push.
  const have = new Set(loaded.map((r) => r.id));
  for (const s of seed) {
    if (have.has(s.id)) continue;
    records.push(s);
    pushes.push(s);
  }

  return { records, pushes, drops, notices };
}
