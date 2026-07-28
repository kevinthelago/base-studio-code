#!/usr/bin/env node
// Driver for the reimplemented-component repair (#3895). Reads the doctor's own findings so the work list
// is never a hand-copied list that drifts from the check.
//
//   node scripts/repair-run.cjs <findings.json> <store.json> [--write]
//
// findings.json — `bsc ui doctor --kit K --json`
// store.json    — `bsc ui list --full`
// Prints one line per occurrence; with --write emits the repaired records to repaired.json for `bsc ui set`.
"use strict";
const fs = require("node:fs");
const { declSpan, aliasFor, addImport } = require("./repair-reimplemented.cjs");

const [findingsPath, storePath, ...flags] = process.argv.slice(2);
const write = flags.includes("--write");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const findingsRaw = read(findingsPath);
const findings = (Array.isArray(findingsRaw) ? findingsRaw : findingsRaw.findings ?? []).filter(
  (f) => f.category === "reimplemented-component",
);
const store = read(storePath);
const byId = new Map(store.map((c) => [c.id, c]));

/** The names a finding says are re-declared — parsed from the backticked list in `why`. */
function namesOf(f) {
  const seg = f.why.split(" declares ")[1]?.split(" locally")[0] ?? "";
  return [...seg.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

const repaired = [];
let fixed = 0;
let skipped = 0;

for (const f of findings) {
  const rec = byId.get(f.nodeIds[0]);
  if (!rec) { console.log(`SKIP ${f.nodeIds[0]} — not in store`); skipped++; continue; }
  // The target node must live in the SAME kit — that is what the preview's sibling resolution can reach.
  const sameKit = store.filter((c) => c.kitId === rec.kitId);
  let src = rec.srcText ?? "";
  const applied = [];
  for (const name of namesOf(f)) {
    // Never an import of the record's OWN module: several nodes are routinely extracted from one file
    // (`AgentFace` + `TeamsCanvas` from TeamsCanvas.tsx), and that closure legitimately holds both.
    const target = sameKit.find((c) => c.name === name && c.id !== rec.id && !(c.src === rec.src && !!rec.src));
    const spec = aliasFor(target?.src);
    if (!spec) { console.log(`  SKIP ${rec.id} ${name} — target ${target ? `src=${target.src}` : "missing"}`); skipped++; continue; }
    const span = declSpan(src, name);
    if (!span) { console.log(`  SKIP ${rec.id} ${name} — no top-level declaration found`); skipped++; continue; }
    src = src.slice(0, span.start) + src.slice(span.end);
    src = addImport(src, name, spec);
    applied.push(`${name}→${spec}`);
    fixed++;
  }
  if (applied.length === 0) continue;
  console.log(`FIX  ${rec.kitId}/${rec.id}  ${applied.join("  ")}`);
  repaired.push({ ...rec, srcText: src });
}

console.log(`\n${repaired.length} records · ${fixed} imports restored · ${skipped} skipped`);
if (write) {
  fs.writeFileSync("repaired.json", JSON.stringify(repaired, null, 2) + "\n");
  console.log("wrote repaired.json");
}
