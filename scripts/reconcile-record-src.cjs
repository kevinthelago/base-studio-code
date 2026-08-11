#!/usr/bin/env node
// reconcile-record-src — the record↔file provenance reconcile (`record-src-reconcile`).
//
// WHY IT EXISTS. Deleting a migrated file whose record is the OLDER copy is a silent revert of real
// work, with nothing to notice it. #4235 found that when a record and its file disagree, the FILE was
// the newer copy in nine of nine cases — including #3775's Tier-0 keyboard operability, which had
// reached the files while the records still rendered pre-a11y markup. So every record's `src` has to be
// resolved before ANY file in that set can be deleted, which is the gate in front of the whole
// file-retirement track.
//
// WHY A SCRIPT AND NOT A ONE-SHOT. #4223 shipped the DETECTOR (`bsc ui backing audit`) and deferred the
// mutation; a one-shot that cannot be re-run leaves no way to check for regression. This reports on every
// run and only writes under `--apply`, so the same command answers "what is wrong" and "fix what can be
// fixed mechanically" — and answers the first one again afterwards.
//
// IT READS THE SEED, not the store. `bsc ui backing audit` covers the store (what the running app
// renders, #3723); this covers `data/components/app/**`, which is what ships to a fresh install. They are
// DIFFERENT populations — the store carries harvested and de-seeded records the seed has never held — and
// a fix to one leaves the other wrong, so both are reported.
//
//   node scripts/reconcile-record-src.cjs                # report only
//   node scripts/reconcile-record-src.cjs --json         # machine-readable
//   node scripts/reconcile-record-src.cjs --apply        # re-point what is UNAMBIGUOUS; never guesses
//
// VERDICTS
//   ok            — `src` resolves and the record carries the symbol the file exports
//   null-src      — no `src` at all: the convention for a record with no file counterpart
//   stale-pointer — `src` names a file that is not here (a rename, or a deleted file)
//   moved         — `src` resolves, but the record's SYMBOL is not in it — re-point, do not refresh
//   drifted       — `src` resolves, the symbol is still there, and the two bodies disagree
//   intentional   — drifted, with `srcDivergence` on the record saying WHY (criterion: the reason lives
//                   where a future sweep reads it, never only in a commit message)
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SEED_DIR = path.join(ROOT, "src-tauri", "data", "components", "app");

const APPLY = process.argv.includes("--apply");
const AS_JSON = process.argv.includes("--json");

/** Every packaged seed record, with the file it was read from so `--apply` can write it back. */
function loadSeed() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        try {
          out.push({ file: p, rec: JSON.parse(fs.readFileSync(p, "utf8")) });
        } catch (err) {
          out.push({ file: p, rec: null, parseError: String(err) });
        }
      }
    }
  };
  walk(SEED_DIR);
  return out;
}

/** The symbols a module exports. Deliberately textual — this runs in the default gate where esbuild
 *  cannot, and it only needs the NAMES, which a regex reads reliably enough for a provenance check. */
function exportedSymbols(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** A record's own component symbol — what it must still contain for the record to be describing the
 *  same thing its `src` does. Prefers the declared `name`, falls back to its first export. */
function recordSymbol(rec) {
  if (rec.name && /^[A-Za-z_]\w*$/.test(rec.name)) return rec.name;
  const first = exportedSymbols(rec.srcText ?? "").values().next();
  return first.done ? null : first.value;
}

/** The "significant lines" of a module — the comparison unit for similarity. Trimmed, and short lines
 *  (`}`, `);`, blanks) dropped: they are identical in every React file and would float every score. */
function lineSet(src) {
  const s = new Set();
  for (const raw of src.split("\n")) {
    const t = raw.trim();
    if (t.length > 12) s.add(t);
  }
  return s;
}

/** Jaccard overlap of two line sets — 1.0 identical, 0.0 disjoint.
 *
 *  WHY SIMILARITY AND NOT SYMBOL MATCHING. The first cut of this script looked for a file exporting the
 *  record's symbol, and reported "no candidate" for 40 of the 44 stale pointers — which read as "the file
 *  is gone, null the pointer". It was WRONG: `GitHubPulse.tsx` → `Pulse.tsx` renamed the file AND the
 *  symbol, so a symbol search cannot see it. Nulling those would have cut the `backing` link on files
 *  that are alive, so `bsc ui backing gate` would stop protecting them and an edit to the file would
 *  silently leave the record holding the old body — the exact #4193 failure this whole track exists to
 *  prevent. Content survives a rename; a name does not. */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const line of small) if (large.has(line)) inter++;
  return inter / (a.size + b.size - inter);
}

/** How much of the RECORD still lives in the file: |A∩B| / |A|.
 *
 *  THIS, not Jaccard, is the drift measure. Many records are a component LIFTED OUT of a larger file
 *  (`teams-org-legend` and `teams-agent-face` both come from `TeamsCanvas.tsx`), so the file legitimately
 *  holds far more than the record does. Jaccard reads that size gap as disagreement and flagged 205 of
 *  384 records as drifted — mostly records that are perfectly faithful to the part of the file they
 *  describe. Containment asks the question that actually matters: are the record's own lines still in the
 *  file, or has the file moved on without it? */
function containment(rec, file) {
  if (!rec.size) return 1;
  let inter = 0;
  for (const line of rec) if (file.has(line)) inter++;
  return inter / rec.size;
}

/** Every source file under src/, with its line set precomputed once. */
function indexSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) {
        const rel = path.relative(ROOT, p).replace(/\\/g, "/");
        try { files.push({ rel, lines: lineSet(fs.readFileSync(p, "utf8")) }); } catch { /* unreadable */ }
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return files;
}

/** The best file for a record's content, and the runner-up — a re-point is only safe when the winner is
 *  strong AND clearly ahead, so a near-tie is reported for a human rather than guessed at. */
function bestMatch(recLines, files) {
  let best = { rel: null, score: 0 };
  let second = { rel: null, score: 0 };
  for (const f of files) {
    // Containment for the same reason drift uses it: a lifted record is fully inside a much larger file.
    const score = containment(recLines, f.lines);
    if (score > best.score) { second = best; best = { rel: f.rel, score }; }
    else if (score > second.score) second = { rel: f.rel, score };
  }
  return { best, second };
}

const REPOINT_MIN = 0.35;   // below this the winner is not really "the same module"
const REPOINT_LEAD = 1.5;   // and it must be this many times the runner-up

/** How close a record must still be to its file to count as describing it. Below this the record is the
 *  older copy (or the file moved on without it) and needs a per-record verdict — #4235 found the FILE was
 *  the newer side in nine of nine cases it checked, so "refresh from the file" is the default, not a tie. */
const DRIFT_MIN = 0.8;

function classify(rec, files) {
  const src = (rec.src ?? "").trim();
  const sym = recordSymbol(rec);
  const recLines = lineSet(rec.srcText ?? "");
  if (!src) return { verdict: "null-src", symbol: sym };

  const abs = path.join(ROOT, src);
  if (!fs.existsSync(abs)) {
    // A RENAME is the usual cause, and content is what survives one. Re-point only on a strong, clearly
    // leading match; anything else is reported for a human.
    const { best, second } = bestMatch(recLines, files);
    const confident = best.rel && best.score >= REPOINT_MIN && best.score >= second.score * REPOINT_LEAD;
    return {
      verdict: "stale-pointer", symbol: sym,
      best: best.rel, score: +best.score.toFixed(3),
      runnerUp: second.rel, runnerUpScore: +second.score.toFixed(3),
      confident: !!confident,
    };
  }

  const fileSrc = fs.readFileSync(abs, "utf8");
  const score = containment(recLines, lineSet(fileSrc));
  if (score >= DRIFT_MIN) return { verdict: "ok", symbol: sym, score: +score.toFixed(3) };
  if (rec.srcDivergence) return { verdict: "intentional", symbol: sym, score: +score.toFixed(3), reason: rec.srcDivergence };

  // MOVED vs DRIFTED — a distinction the score alone cannot make, and they need OPPOSITE remedies.
  // `folderglyph` points at `designs/RailTree.tsx`, which still exists, but `FolderGlyph` now lives in
  // `shared/ui/layouts/RailFolderRow.tsx`: the pointer is wrong, so re-point. `teams-org-legend` points
  // at `TeamsCanvas.tsx` and `OrgLegend` is STILL THERE: the pointer is right and the bodies disagree, so
  // refresh. Treating a move as drift would refresh the record from a file that no longer describes it.
  const stillHere = sym && (new RegExp(`\\b(?:function|const|class)\\s+${sym}\\b`).test(fileSrc) || exportedSymbols(fileSrc).has(sym));
  if (!stillHere) {
    const { best, second } = bestMatch(recLines, files);
    const confident = best.rel && best.rel !== src && best.score >= REPOINT_MIN && best.score >= second.score * REPOINT_LEAD;
    return {
      verdict: "moved", symbol: sym, score: +score.toFixed(3),
      best: best.rel, bestScore: +best.score.toFixed(3),
      runnerUp: second.rel, runnerUpScore: +second.score.toFixed(3), confident: !!confident,
    };
  }
  return { verdict: "drifted", symbol: sym, score: +score.toFixed(3) };
}

function main() {
  const seed = loadSeed();
  const files = indexSourceFiles();
  const rows = [];
  let repointed = 0;

  for (const entry of seed) {
    if (!entry.rec) { rows.push({ file: entry.file, verdict: "parse-error", detail: entry.parseError }); continue; }
    const rec = entry.rec;
    const res = classify(rec, files);
    const row = { id: rec.id, src: rec.src ?? null, file: path.relative(ROOT, entry.file).replace(/\\/g, "/"), ...res };

    if (APPLY && (res.verdict === "stale-pointer" || res.verdict === "moved") && res.confident) {
      rec.src = res.best;
      fs.writeFileSync(entry.file, JSON.stringify(rec, null, 2) + "\n", "utf8");
      row.repointedTo = res.best;
      repointed++;
    }
    rows.push(row);
  }

  const counts = rows.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  const summary = { total: rows.length, counts, repointed, applied: APPLY };

  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + "\n");
    return;
  }

  console.log(`\nrecord↔file provenance — ${rows.length} packaged records under data/components/app/**`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
  if (APPLY) console.log(`\n  re-pointed: ${repointed}`);

  const stale = rows.filter((r) => r.verdict === "stale-pointer");
  if (stale.length) {
    console.log(`\nSTALE POINTERS (${stale.length}) — src names a file that is not here:`);
    for (const r of stale) {
      const fix = r.repointedTo
        ? `  ⇒ re-pointed to ${r.repointedTo} (${r.score})`
        : r.confident
          ? `  ⇒ --apply would re-point to ${r.best} (${r.score}, runner-up ${r.runnerUpScore})`
          : r.best && r.score > 0.1
            ? `  ⇒ WEAK/AMBIGUOUS best=${r.best} (${r.score}) runner-up=${r.runnerUp} (${r.runnerUpScore}) — decide by hand`
            : `  ⇒ NO match in src/ — the file is genuinely gone; null the pointer`;
      console.log(`  ${r.id.padEnd(30)} ${r.src}\n${fix}`);
    }
  }

  const moved = rows.filter((r) => r.verdict === "moved");
  if (moved.length) {
    console.log(`
MOVED (${moved.length}) — src resolves, but the record's symbol is no longer in that file:`);
    for (const r of moved) {
      const fix = r.repointedTo
        ? `  ⇒ re-pointed to ${r.repointedTo}`
        : r.confident
          ? `  ⇒ --apply would re-point to ${r.best} (${r.bestScore}, runner-up ${r.runnerUpScore})`
          : `  ⇒ best=${r.best} (${r.bestScore}) runner-up=${r.runnerUp} (${r.runnerUpScore}) — decide by hand`;
      console.log(`  ${r.id.padEnd(30)} ${r.symbol ?? "?"} not in ${r.src}
${fix}`);
    }
  }

  const drifted = rows.filter((r) => r.verdict === "drifted");
  if (drifted.length) {
    console.log(`\nDRIFTED (${drifted.length}) — src resolves, but the record is not what the file holds:`);
    for (const r of drifted.sort((a, b) => a.score - b.score)) {
      console.log(`  ${String(r.score).padEnd(6)} ${r.id.padEnd(30)} ${r.src}`);
    }
    console.log(`\n  Each needs a per-record verdict: refresh FROM the file (#4235's 9/9 default),`);
    console.log(`  confirm the file as the stale side, or record the reason in \`srcDivergence\`.`);
  }
  console.log("");
}

main();
