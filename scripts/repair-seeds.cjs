#!/usr/bin/env node
// Apply the reimplemented-component repair to the SEED records in src-tauri/data/components/** (#3895).
//
// The seed is the durable source: the `harvested` kit is store-only (no seed files), but every
// `base-studio-code` record IS seeded, so a repair that only touched the live store would be undone by the
// next re-seed. Store and seed are updated as a pair — see the store-vs-seed note in the issue.
//
//   node scripts/repair-seeds.cjs <findings.json> <store.json> [--write]
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { declSpan, aliasFor, addImport } = require("./repair-reimplemented.cjs");

const [findingsPath, storePath, ...flags] = process.argv.slice(2);
const write = flags.includes("--write");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const ROOT = path.join(__dirname, "..", "src-tauri", "data", "components");
/** Every seed json under data/components, by record id. */
function seedIndex(dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) seedIndex(p, out);
    else if (e.name.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const r of Array.isArray(j) ? j : [j]) if (r && r.id) out.set(r.id, { file: p, isArray: Array.isArray(j) });
      } catch { /* not a record file */ }
    }
  }
  return out;
}

const seeds = seedIndex(ROOT);
const findingsRaw = read(findingsPath);
const findings = (Array.isArray(findingsRaw) ? findingsRaw : findingsRaw.findings ?? []).filter(
  (f) => f.category === "reimplemented-component",
);
const store = read(storePath);

const namesOf = (f) => [...(f.why.split(" declares ")[1]?.split(" locally")[0] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);

let touched = 0;
for (const f of findings) {
  const id = f.nodeIds[0];
  const seed = seeds.get(id);
  if (!seed) { console.log(`skip ${id} — store-only (no seed file)`); continue; }
  if (seed.isArray) { console.log(`SKIP ${id} — lives in a multi-record file, repair by hand`); continue; }
  const rec = JSON.parse(fs.readFileSync(seed.file, "utf8"));
  const kitPeers = store.filter((c) => c.kitId === rec.kitId);
  let src = rec.srcText ?? "";
  const applied = [];
  for (const name of namesOf(f)) {
    const target = kitPeers.find((c) => c.name === name && c.id !== id && !(c.src === rec.src && !!rec.src));
    const spec = aliasFor(target?.src);
    if (!spec) { console.log(`  skip ${id} ${name} — no module-path target`); continue; }
    const span = declSpan(src, name);
    if (!span) { console.log(`  skip ${id} ${name} — no top-level declaration`); continue; }
    src = src.slice(0, span.start) + src.slice(span.end);
    src = addImport(src, name, spec);
    applied.push(`${name}→${spec}`);
  }
  if (!applied.length) continue;
  console.log(`FIX  ${path.relative(ROOT, seed.file)}  ${applied.join("  ")}`);
  if (write) {
    rec.srcText = src;
    fs.writeFileSync(seed.file, JSON.stringify(rec, null, 2) + "\n");
  }
  touched++;
}
console.log(`\n${touched} seed file(s) ${write ? "written" : "would change"}`);
