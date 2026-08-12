#!/usr/bin/env node
// reconcile-record-fields — settle seed↔store divergence PER FIELD (#4207).
//
// ## The decision this implements
//
// Maintainer's call: **the STORE wins on metadata, the SEED wins on `srcDivergence`.** Neither side was
// authoritative for everything — measured across 379 records, the store is ahead on what the harvest and
// the Design Studio wrote (`folder`, `tests`, `composes`, `provides`, `name`), the seed is ahead on the
// provenance `record-src-reconcile` authored (`srcDivergence`, `src`, `srcRetired`). Picking one side
// wholesale would have destroyed the other's work, which is why a mass re-stamp was refused.
//
// ## `srcText` is NOT covered, deliberately
//
// It differs on 100 records and it is neither metadata nor provenance — it is the component. The drift
// runs both ways (`skillspage` store is 9137 chars SHORTER than seed; `automationspage` is 4591 LONGER),
// and #4179 suspects at least one page holds half its content in each copy. That is a per-record
// judgement with a diff surface of its own (`bsc ui parity`), not something a field rule can settle.
// This script never writes `srcText`.
//
// ## Two things that look like drift and are not
//
//   * **`group` → `folder` (#4107).** `projectComponent` reads `folder ?? group`, so a store record still
//     keyed `group` holds the SAME value under the OLD name. Raw comparison calls that a difference on
//     324 records; writing the store's `group` back would UNDO the rename. Normalised away here, and the
//     seed is only ever written the modern `folder` key.
//   * **Projection defaults.** `tags ?? []`, `variants?.length ? … : ["default"]`, `src ?? ""`. An absent
//     seed field and a stored `[]` are the same record — only the store round-tripped through the
//     projection that materialised it. Writing those into the seed would add 146 records' worth of noise.
//
//   node scripts/reconcile-record-fields.cjs            # report
//   node scripts/reconcile-record-fields.cjs --apply    # write both directions
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const SEED_DIR = path.join(REPO, "src-tauri", "data", "components", "app");
const APPLY = process.argv.includes("--apply");

/** Metadata the STORE owns — what harvest, the doctor and the Design Studio author. */
const STORE_WINS = [
  "folder", "tests", "composes", "provides", "whenUse", "whenNot", "tags",
  "variants", "name", "props", "role", "version", "shapes", "animations", "analytics", "spec", "wraps", "rules",
];
/** Provenance the SEED owns — what `record-src-reconcile` authored against the files. */
const SEED_WINS = ["srcDivergence", "src", "srcRetired"];
/** Never written by this script. See the header. */
const NEVER = new Set(["srcText", "id", "kitId", "rev", "updatedAt", "updatedBy", "history", "used", "seedHash", "builtin", "suppressed"]);

const DEFAULTS = { tags: [], whenUse: [], whenNot: [], composes: [], props: [], variants: ["default"], src: "", version: "" };

/** The MAIN worktree's root. `target/` is only ever built there, so from a nested `wt-<short>/` this
 *  script finds no binary at all — the same trap `archive-graph.cjs` hit, fixed the same way. */
function mainRoot() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).trim();
    if (common) return path.dirname(common);
  } catch { /* not a checkout */ }
  return REPO;
}

function bscBin() {
  for (const root of [mainRoot(), REPO]) {
    for (const rel of [["target", "debug", "bsc.exe"], ["target", "release", "bsc.exe"], ["target", "debug", "bsc"]]) {
      const p = path.join(root, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("no bsc binary — build one with `cargo build -p bsc --bin bsc`");
}

/** As `projectComponent` would see it: `folder` absorbs the legacy `group`, defaults materialised. */
function norm(rec) {
  const out = { ...rec };
  if (out.group !== undefined) { if (out.folder === undefined) out.folder = out.group; delete out.group; }
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = d;
  }
  if (!Array.isArray(out.variants) || out.variants.length === 0) out.variants = ["default"];
  return out;
}

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

const bsc = bscBin();
const store = new Map();
for (const r of JSON.parse(execFileSync(bsc, ["ui", "list", "--full"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }) || "[]")) {
  if (r && r.id) store.set(r.id, r);
}

let toSeed = 0, toStore = 0, seedFiles = 0, storeRecords = 0;
const srcTextDrift = [];
const pending = new Map(); // id -> patch for the store

for (const file of walk(SEED_DIR)) {
  let seed;
  try { seed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
  if (!seed.id) continue;
  const st = store.get(seed.id);
  if (!st) continue;

  const ns = norm(seed), nt = norm(st);
  if (!eq(ns.srcText, nt.srcText)) srcTextDrift.push(seed.id);

  // ── STORE -> SEED (metadata) ─────────────────────────────────────────────────────────────────
  let seedChanged = false;
  for (const k of STORE_WINS) {
    if (NEVER.has(k) || eq(ns[k], nt[k])) continue;
    const v = nt[k];
    // Never write a projection default into the seed — that is noise, not information.
    if (eq(v, DEFAULTS[k]) && seed[k] === undefined) continue;
    if (v === undefined || v === null) continue;
    seed[k] = v;
    if (k === "folder") delete seed.group; // the modern key only
    seedChanged = true;
    toSeed++;
  }
  if (seedChanged) {
    seedFiles++;
    if (APPLY) fs.writeFileSync(file, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }

  // ── SEED -> STORE (provenance) ───────────────────────────────────────────────────────────────
  const patch = { id: seed.id };
  let storeChanged = false;
  for (const k of SEED_WINS) {
    if (eq(ns[k], nt[k])) continue;
    // `src` normalises "" for an absent value; send null to CLEAR rather than store an empty string.
    patch[k] = seed[k] === undefined ? null : seed[k];
    storeChanged = true;
    toStore++;
  }
  if (storeChanged) { storeRecords++; pending.set(seed.id, patch); }
}

console.log(`seed↔store field reconcile   (store wins on metadata · seed wins on srcDivergence)`);
console.log(`  STORE -> SEED : ${toSeed} field(s) across ${seedFiles} record(s)`);
console.log(`  SEED -> STORE : ${toStore} field(s) across ${storeRecords} record(s)`);
console.log(`  srcText differs on ${srcTextDrift.length} record(s) — NOT touched; per-record judgement (\`bsc ui parity\`)`);

if (APPLY && pending.size) {
  // One batched write: `bsc ui set` accepts an array, and 300 spawns is the fan-out shape this repo has
  // repeatedly paid for (#3908/#3912/#3944/#3954).
  execFileSync(bsc, ["ui", "set", "--by", "record-field-reconcile", "--note", "seed provenance -> store (#4207)"],
    { input: JSON.stringify([...pending.values()]), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  console.log(`\n  wrote ${pending.size} store record(s)`);
}
if (APPLY) console.log(`  wrote ${seedFiles} seed file(s)`);
else console.log(`\n  (report only — pass --apply to write)`);
