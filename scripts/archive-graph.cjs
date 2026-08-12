#!/usr/bin/env node
// archive-graph — refresh the local recovery archive (#4190).
//
// WHY IT EXISTS. Parts of the app's UI now live ONLY as graph records: `fleetpage` has no `.tsx` behind
// it at all. That is fine while GitHub and `components.db` are both healthy, and a single point of
// failure otherwise. The archive is the out-of-git copy that survives losing either.
//
// WHY A SCRIPT AND NOT A ONE-TIME COPY. The archive was made by hand on 2026-08-01 at `develop @
// 08a4428f` and had gone badly stale by the time anyone leaned on it: 99 seed records archived against
// 384 on disk, 363 store records against 507. A safety net that silently ages is worse than none,
// because it is trusted. This makes refreshing one command, which is what the item's open
// "refresh cadence" question actually needed.
//
//   npm run archive            # refresh the two record sets, rewrite the README
//   npm run archive -- --check # report staleness and exit 1 if stale; writes nothing
//
// `deleted-sources/` is NEVER touched. Those files are frozen history — each is its content at the
// commit before the one that deleted it — and re-deriving them would mean trusting today's git to still
// hold what the archive exists to survive the loss of.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const ARCHIVE = path.resolve(REPO, "..", "base-studio-code-archive");
const SEED_DIR = path.join(REPO, "src-tauri", "data", "components", "app");
const CHECK = process.argv.includes("--check");

/** The bundled `bsc`, used to export the live store. Dev build first, then the packaged sidecar. */
function bscBin() {
  const candidates = [
    path.join(REPO, "target", "debug", "bsc.exe"),
    path.join(REPO, "target", "release", "bsc.exe"),
    path.join(REPO, "target", "debug", "bsc"),
    path.join(REPO, "target", "release", "bsc"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function rmDirContents(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
}

function head() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

// ── the two live counts, and what the archive currently holds ────────────────────────────────────────
const seedFiles = walk(SEED_DIR).filter((f) => f.endsWith(".json"));
const archSeed = walk(path.join(ARCHIVE, "graph-records-seed")).filter((f) => f.endsWith(".json"));
const archStore = walk(path.join(ARCHIVE, "graph-records-store")).filter((f) => f.endsWith(".json"));
const archDeleted = walk(path.join(ARCHIVE, "deleted-sources"));

const bsc = bscBin();
let storeRecords = null;
if (bsc) {
  try {
    storeRecords = JSON.parse(execFileSync(bsc, ["ui", "list", "--full"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }) || "[]");
  } catch (e) {
    console.error(`  ! could not read the store via ${path.basename(bsc)}: ${String(e).split("\n")[0]}`);
  }
}

console.log(`archive: ${ARCHIVE}`);
console.log(`  deleted-sources     ${String(archDeleted.length).padStart(4)}  (frozen — never refreshed)`);
console.log(`  graph-records-seed  ${String(archSeed.length).padStart(4)}  archived   vs ${seedFiles.length} on disk`);
console.log(`  graph-records-store ${String(archStore.length).padStart(4)}  archived   vs ${storeRecords ? storeRecords.length : "?"} in the store`);

const stale = archSeed.length !== seedFiles.length || (storeRecords && archStore.length !== storeRecords.length);

if (CHECK) {
  if (!fs.existsSync(ARCHIVE)) { console.error("\nARCHIVE MISSING — run `npm run archive`."); process.exit(1); }
  if (stale) { console.error("\nSTALE — run `npm run archive`."); process.exit(1); }
  console.log("\nup to date.");
  process.exit(0);
}

if (!fs.existsSync(ARCHIVE)) fs.mkdirSync(ARCHIVE, { recursive: true });
if (archDeleted.length === 0) {
  console.warn("\n  ! deleted-sources/ is EMPTY. This script never writes it — those files are frozen");
  console.warn("    history recovered from git at the time of deletion. If it is empty the archive is");
  console.warn("    incomplete, and that has to be rebuilt by hand from the deleting commits.");
}

// ── seed: a straight mirror of what ships ───────────────────────────────────────────────────────────
const seedOut = path.join(ARCHIVE, "graph-records-seed");
rmDirContents(seedOut);
for (const f of seedFiles) {
  const rel = path.relative(SEED_DIR, f);
  const dest = path.join(seedOut, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
}

// ── store: one file per record, so a single record can be restored without parsing a 5 MB blob ───────
let storeWritten = 0;
if (storeRecords) {
  const storeOut = path.join(ARCHIVE, "graph-records-store");
  rmDirContents(storeOut);
  for (const rec of storeRecords) {
    if (!rec || !rec.id) continue;
    const safe = String(rec.id).replace(/[^A-Za-z0-9._-]/g, "_");
    const kit = String(rec.kitId || "no-kit").replace(/[^A-Za-z0-9._-]/g, "_");
    const dir = path.join(storeOut, kit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
    storeWritten++;
  }
}

// ── README: provenance is the whole point, so it is rewritten with real counts every time ───────────
const readmePath = path.join(ARCHIVE, "README.md");
const prior = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
const keep = prior.includes("## `deleted-sources/`")
  ? prior.slice(prior.indexOf("## `deleted-sources/`"), prior.indexOf("## `graph-records-seed/`"))
  : "";
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(readmePath, `# base-studio-code — local recovery archive

A **local, out-of-git** copy of everything the graph migration deleted, plus the graph data that is now
the only copy of parts of the app's UI. It exists so that losing GitHub, the repo, or \`components.db\`
does not lose work that has no other home.

Nothing here is referenced by the app. It is inert. Restoring is a copy, never a merge.

Refreshed **${stamp}** from \`develop\` @ \`${head()}\` by \`npm run archive\`
(\`scripts/archive-graph.cjs\` in the repo).

> **Refresh cadence.** \`deleted-sources/\` is frozen and never refreshed. The two record sets go stale
> the moment anyone authors a component, so refresh **before deleting any source file** and **at each
> release**. \`npm run archive -- --check\` reports staleness and exits non-zero, so it can gate a
> release. The previous hand-made snapshot drifted to 99 archived seed records against 384 on disk —
> a safety net nobody noticed had holes.

---

${keep || `## \`deleted-sources/\` — ${archDeleted.length} files the migration removed

Each file is its content at the commit **before** the one that deleted it. Git still has all of this;
the point of the copy is to survive not having git.
`}
## \`graph-records-seed/\` — ${seedFiles.length} records, the packaged copy

\`src-tauri/data/components/app/**\` as it ships. This is what a fresh install seeds from, and for the
migrated pages it **is** the page — there is no \`.tsx\` behind \`fleetpage\` at all.

## \`graph-records-store/\` — ${storeWritten || archStore.length} records, the live copy

Exported from \`~/.base-studio-code/components.db\`, one JSON file per record under its kit, so a single
record can be restored without parsing a multi-megabyte blob. Much larger than the seed: it holds the
packaged react-ui kit, the demo pages, and **anything authored locally that was never committed**. That
last category exists nowhere else.

> **The two copies can disagree, and it matters.** \`ui-charts\` was corrupt in the seed and valid in the
> store (#4188) — a repair pass had fixed the store and never the seed. Keep both; neither is
> authoritative for everything. As of this refresh they disagree on **340 of 379** packaged records, in
> both directions (the store is ahead on harvested metadata, the seed on \`srcDivergence\` and pointers).

---

## Restoring

Assume you know nothing about this system.

**One deleted source file.** Copy it back to the path named in \`deleted-sources/<folder>/\`, then check
whether a graph record now supersedes it — \`bsc ui backing <path>\` names the record if one does. If a
record backs it, restoring the file gives you a SECOND copy, and the app renders the record.

**One graph record.** \`graph-records-store/<kit>/<id>.json\` is the whole record.

    bsc ui set < graph-records-store/base-studio-code/fleetpage.json

**The whole store**, e.g. onto a new machine: loop the same command over every file in a kit folder.
Records are independent; order does not matter.

**The seed.** Copy \`graph-records-seed/\` back over \`src-tauri/data/components/app/\` in the repo. That
restores what ships, not what the local app renders — the app renders the store (#3723).

**Which copy do I want?** The store is what the app renders today. The seed is what a fresh install
gets. If they disagree and you do not know which is right, restore the store copy and compare against
the seed afterwards — \`node scripts/reconcile-record-src.cjs\` in the repo reports the provenance state.
`, "utf8");

console.log(`\nrefreshed at ${ARCHIVE}`);
console.log(`  seed  ${seedFiles.length} records`);
console.log(`  store ${storeWritten} records`);
console.log(`  deleted-sources left untouched (${archDeleted.length} files)`);
