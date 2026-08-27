// Sync a NAMED impl record's CONTENT from the store into the packaged seed.
//
// `promote-records.mjs` only promotes records whose FILE still exists — a record that is ALREADY the
// only copy (its file long retired) is "already seeded" and never reconsidered. So a deliberate edit
// to such a record lands in the store and stops there, and the app keeps shipping the old body.
//
// This is deliberately BY ID and never a sweep: seed and store have diverged BOTH ways across ~340
// records, and a mass re-stamp would overwrite real seed content with stale store content. It prints
// which fields changed, and their before/after sizes, so the direction of the change is visible before
// it is trusted.
//
// #145: this used to compare (and copy) `code` ONLY. `bsc graph tests set` writes a record's `tests`
// facet — same as `--domain`/`--kind`/`vizCode` — and a `code`-only diff called that "already identical"
// even though the field that actually changed was never looked at. The comparison now mirrors
// `repo_store::content_of`/`verdict_for` on the Rust side (crates/bsc-graph/src/repo_store.rs): the
// WHOLE record, minus write bookkeeping (`history`/`rev`/`updatedAt`/`updatedBy`/`build` — fields the
// store carries and the seed never does), and it refuses to sync an id whose store copy is MISSING a
// field the seed already carries, so a stale runtime store can never delete richer seed content.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// #139: the Windows dev-box fallback path was dead since the linux-host migration — this repo's own
// scripts run with $BSC_BIN set, so the fallback only ever fires from a bare shell, where the bundled
// binary's real home (`census-claims.mjs`'s own fallback) is the honest guess.
const BSC = process.env.BSC_BIN ?? join(process.env.HOME ?? "", ".base-studio-code", "bin", "bsc");
const SEED = "src-tauri/data/knowledge/algorithms.json";

// Mirrors `repo_store::content_of` — write bookkeeping the store carries and the seed never does.
const BOOKKEEPING = ["history", "rev", "updatedAt", "updatedBy", "build"];

export function contentOf(rec) {
  const c = { ...rec };
  for (const k of BOOKKEEPING) delete c[k];
  return c;
}

/**
 * Re-serialize the seed EXACTLY as it is stored on disk: 1-space indent, non-ASCII escaped, and NO
 * trailing newline — i.e. Python's `json.dumps(d, indent=1, ensure_ascii=True)`, which is what writes
 * this file today.
 *
 * This is not cosmetic. `JSON.stringify(seed, null, 2)` + "\n" re-indents all 6.3 MB, so a two-record
 * sync produced a 22,500-line diff in which the actual change was invisible — unreviewable, and it
 * would have carried a whole-file reformat into every branch that ran this script once.
 */
function serializeSeed(value) {
  return JSON.stringify(value, null, 1).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function isEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => isEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.hasOwn(b, k) && isEqual(a[k], b[k]));
  }
  return false;
}

// Would writing `fresh` over `existing` DROP a non-empty field `existing` carries? Mirrors
// `repo_store::loses_fields` — key PRESENCE, not value equality, and an empty value is nothing to lose.
export function losesFields(fresh, existing) {
  return Object.entries(existing).some(([k, v]) => {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) return false;
    return !Object.hasOwn(fresh, k);
  });
}

// The top-level content keys that differ between `existing` (the seed record) and `fresh` (the store
// record) — reported so the direction and shape of a sync is visible before it is trusted.
export function diffFields(existing, fresh) {
  const keys = new Set([...Object.keys(existing), ...Object.keys(fresh)]);
  return [...keys].filter((k) => !isEqual(existing[k], fresh[k])).sort();
}

// Merge the two store tiers (impls + edges, request #151) into one id → record lookup. They share one
// id space by construction (an edge id joins its members with `--`, an impl id is a bare file/name), so
// a genuine collision is a data problem worth failing loudly on rather than silently picking a side.
export function mergeStores(implRecords, edgeRecords) {
  const byId = new Map();
  for (const r of implRecords) byId.set(r.id, r);
  for (const r of edgeRecords) {
    if (byId.has(r.id)) {
      throw new Error(`id '${r.id}' exists as BOTH an impl and an edge in the store — ambiguous sync target`);
    }
    byId.set(r.id, r);
  }
  return byId;
}

// One id's sync verdict: "skip-not-in-store" | "skip-not-in-seed" | "up-to-date" | "would-lose-fields" | "sync".
// `--only <field>` — sync exactly ONE field and leave everything else alone.
//
// Needed because the store and the seed have diverged BOTH ways across ~340 records (see the header),
// so a whole-record sync of a NEW facet would drag that unrelated drift along with it under cover of
// the change being made. Measured when the `feature` axis landed: of 670 impls, 617 differed only by
// `feature`, 38 also carried drift in `tests`/`code`/`name`, and 13 were refused outright by the
// loses-fields guard. Without this flag those 52 stay unplaced, and a rule enforced over the seed then
// silently skips them — which is exactly how a gate passes while covering less than the reader assumes.
//
// It is deliberately NOT a general filter: one named field, so the diff a reader reviews is one column.
export function planOne(seedImpls, storeById, id, only) {
  const s = storeById.get(id);
  const t = seedImpls.find((im) => im.id === id);
  if (!s) return { id, verdict: "skip-not-in-store" };
  if (!t) return { id, verdict: "skip-not-in-seed" };
  const existing = contentOf(t);
  const fresh = only
    // ONE field, merged onto the seed record: everything else stays exactly as the seed has it, so no
    // drift rides along and the loses-fields guard has nothing to refuse.
    ? (Object.hasOwn(contentOf(s), only) ? { ...existing, [only]: contentOf(s)[only] } : existing)
    : contentOf(s);
  if (isEqual(existing, fresh)) return { id, verdict: "up-to-date" };
  if (losesFields(fresh, existing)) {
    return { id, verdict: "would-lose-fields", fields: diffFields(existing, fresh) };
  }
  return { id, verdict: "sync", fields: diffFields(existing, fresh), fresh };
}

function main() {
  const APPLY = process.argv.includes("--apply");
  const rawArgs = process.argv.slice(2);
  const onlyAt = rawArgs.indexOf("--only");
  const IDS = rawArgs.filter((a, i) => !a.startsWith("--") && i !== onlyAt + 1);
  // `--only <field>` takes the NEXT argument, so it is filtered out of the id list above by the
  // `--`-prefix rule and read positionally here.
  const onlyIdx = process.argv.indexOf("--only");
  const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : undefined;
  if (!IDS.length) { console.error("usage: node sync-impl-seed.mjs <impl-id-or-edge-id>… [--only <field>] [--apply]"); process.exit(2); }

  // Request #151: an EDGE (the relationship tier, `bsc graph edge …`) carries `tests` the same way an
  // impl does, but the store map used to come from `impl list` only — so an edge id always reported
  // "not in the store", with no path to the packaged seed at all. Both tiers share one id space and one
  // record shape here, so they are merged into a single lookup rather than making the caller say which
  // tier an id belongs to.
  const implRecords = JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 }));
  const edgeRecords = JSON.parse(execFileSync(BSC, ["graph", "edge", "list"], { encoding: "utf8", maxBuffer: 1 << 28 }));
  const storeById = mergeStores(implRecords, edgeRecords);

  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const seedImpls = seed.implementations ?? [];
  const seedEdges = seed.edges ?? [];
  // Object references, not copies — mutating a record found through this array mutates the same object
  // `seedImpls`/`seedEdges` holds, so the write below lands in whichever tier the id actually belongs to.
  const seedRecords = [...seedImpls, ...seedEdges];

  let changed = 0;
  for (const id of IDS) {
    const plan = planOne(seedRecords, storeById, id, ONLY);
    switch (plan.verdict) {
      case "skip-not-in-store":
        console.log(`SKIP ${id} — not in the store`);
        break;
      case "skip-not-in-seed":
        console.log(`SKIP ${id} — not in the seed (that would be a PROMOTION, not a sync)`);
        break;
      case "up-to-date":
        console.log(`SKIP ${id} — already identical`);
        break;
      case "would-lose-fields":
        console.log(
          `SKIP ${id} — the store copy is missing field(s) the seed already carries (${plan.fields.join(", ")}); ` +
          "refusing to lose seed content",
        );
        break;
      case "sync": {
        const t = seedRecords.find((im) => im.id === id);
        console.log(`${APPLY ? "SYNC" : "would sync"} ${id}  fields: ${plan.fields.join(", ")}`);
        if (APPLY) {
          for (const k of Object.keys(plan.fresh)) t[k] = plan.fresh[k];
        }
        changed += 1;
        break;
      }
      default:
        break;
    }
  }

  if (APPLY && changed) {
    writeFileSync(SEED, serializeSeed(seed));
    console.log(`wrote ${SEED} (${changed} record(s))`);
  } else if (!APPLY) {
    console.log("(dry run — pass --apply to write)");
  }
}

if (process.argv[1] && process.argv[1].endsWith("sync-impl-seed.mjs")) main();
