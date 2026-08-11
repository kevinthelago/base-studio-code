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
//   node scripts/reconcile-record-src.cjs --annotate     # write an evidenced `srcDivergence` where the
//                                                        #   difference is by construction
//   node scripts/reconcile-record-src.cjs --retire       # `src` -> `srcRetired` where the file is GONE
//                                                        #   and nothing matches: a superseded page copy
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
const ANNOTATE = process.argv.includes("--annotate");
const RETIRE = process.argv.includes("--retire");
const AS_JSON = process.argv.includes("--json");

/** How many substantive lines the FILE's definition may hold that the record's does not, before
 *  "preview parameterization" stops being a full explanation. Above this the record may ALSO be behind,
 *  and annotating it would bury real staleness under a reason that is true but incomplete. */
const BEHIND_MAX = 8;

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
  const own = exportedSymbols(rec.srcText ?? "");
  // `name` only counts if the RECORD ITSELF defines it. A MULTI-SYMBOL record is named for its MODULE,
  // not for any one export — `ui-charts` is called `Charts` while defining LineArea/Bars/Donut/HBars/
  // Swimlane, which are exactly `Charts.tsx`'s exports. Trusting the name there made the check look for a
  // `Charts` symbol that exists in neither side and report the record as MOVED, when its pointer is
  // perfectly correct. So fall through to what the record actually exports.
  if (rec.name && /^[A-Za-z_]\w*$/.test(rec.name) && own.has(rec.name)) return rec.name;
  const first = own.values().next();
  return first.done ? (rec.name && /^[A-Za-z_]\w*$/.test(rec.name) ? rec.name : null) : first.value;
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

/** The SOURCE REGION of one symbol's definition — from its `function`/`const`/`class` keyword to the
 *  matching close brace. Brace-counted rather than parsed: this runs in the default gate where no
 *  TypeScript AST is available, and the count only has to be right for well-formed source.
 *
 *  WHY REGION-SCOPED COMPARISON IS THE ONLY HONEST DRIFT SIGNAL. A whole-file comparison cannot separate
 *  a record that is STALE from one that differs BY CONSTRUCTION — and almost all of them differ by
 *  construction. 72 of the 143 whole-file "drifted" records VENDOR symbols the file merely imports (a
 *  record must be self-standing: the loader resolves only registered modules and sibling records, so a
 *  record inlines what a file is free to import), and most of the rest are a small leaf LIFTED out of a
 *  large file. Both make the file look hundreds of lines "ahead" while the component itself is byte-identical.
 *  Comparing the file's definition of `X` against the record's definition of `X` excludes imports, vendored
 *  helpers, and every other component in the file — leaving the only question that matters: has this
 *  component actually changed since the record captured it? */
function symbolRegion(src, sym) {
  if (!sym) return null;
  const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|class)\\s+${sym}\\b`).exec(src);
  if (!m) return null;
  const start = m.index;
  // Find the BODY brace, not the first one. `function LogView({ paneId }: Props) {` opens a brace inside
  // the parameter list, and matching from there returns just the destructuring pattern — which scored
  // region-similarity 0.00 for 79 records and read as "the body changed completely" when nothing had.
  // The body brace is the first `{` seen at paren depth 0.
  let parens = 0, open = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "{" && parens === 0) { open = i; break; }
    else if (c === ";" && parens === 0) return src.slice(start, i + 1); // a bodyless declaration
  }
  if (open < 0) return src.slice(start, start + 400);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The parameter list of a definition — everything between the first `(` and its matching `)`. */
function signatureOf(region) {
  const i = region.indexOf("(");
  if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < region.length; j++) {
    if (region[j] === "(") depth++;
    else if (region[j] === ")" && --depth === 0) return region.slice(i, j + 1);
  }
  return region.slice(i);
}

/** Parameter names the definition gives a DEFAULT value. Top level only: a default that is itself an
 *  object/JSX literal must not have its inner commas read as further parameters. */
function defaultedParams(sig) {
  const body = sig.replace(/^\(|\)$/g, "");
  const names = [];
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "," && depth <= 1) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  for (const p of parts) {
    const m = /^\s*\{?\s*(\w+)\s*=/.exec(p) || /^\s*(\w+)\s*=/.exec(p.replace(/^\s*\{/, ""));
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

/** WHY THE RECORD AND THE FILE DISAGREE, when the answer is "by construction" and can be evidenced.
 *
 *  The dominant cause is PREVIEW PARAMETERIZATION: the Design Studio mounts a record with NO props, so a
 *  record gives its parameters demo defaults (and often adds loading/error states) that the file, which is
 *  always called with real props, has no use for. `teams-org-legend` is the clearest case — the file's
 *  `OrgLegend()` takes nothing, the record's takes `{ archetypes = DEMO_ARCHETYPES, loading = false, error }`.
 *  The RECORD is the richer copy, so "refresh from the file" would destroy it.
 *
 *  Returns null when parameterization does NOT fully explain the difference — either there is no added
 *  default, or the file's definition still holds substantive lines the record lacks (`behind`), which
 *  means the record may ALSO be stale and needs a human. Annotating those would bury a real defect under
 *  a reason that is true but incomplete. */
function divergenceReason(recRegion, fileRegion, sym) {
  // ── CLASS 2: PREVIEW DATA SUBSTITUTION ────────────────────────────────────────────────────────────
  // The preview mounts a record with no Tauri backend and no app store, so a record that called
  // `invoke(…)` or `useAppStore()` would throw on mount. Records therefore swap the DATA layer for
  // sample constants and inert handlers while keeping the render layer: `storagecard` uses SAMPLE_ROWS
  // where the file calls `invoke("worktrees_disk_usage")`; `permissionposturecard` uses `useState(false)`
  // where the file uses `useAppStore()` + `useSandboxReadiness()`.
  //
  // The honesty check is DIFFERENT from class 1's. The file's live-data lines are legitimately absent from
  // the record, so a line count says nothing — but the RENDER layer should still agree. If the JSX has
  // also moved on, the record is behind on UI as well and substitution is not a full explanation:
  // `tabstrip` is the case that proves it, 21 record lines against 34 in the file, which gained stable
  // tab-id identity and detached-tab handling the record never got. So the markup must match too.
  const LIVE = /\binvoke\s*\(|\buseAppStore\s*\(|\bsafeInvoke\s*\(|\bfireInvoke\s*\(/;
  const SAMPLE = /\b(?:SAMPLE|DEMO|MOCK)_[A-Z0-9_]+\b/g;
  const markup = (r) => new Set(r.split("\n").map((l) => l.trim()).filter((l) => l.includes("<") && l.length > 12));
  const recSamples = new Set(recRegion.match(SAMPLE) ?? []);
  const fileSamples = new Set(fileRegion.match(SAMPLE) ?? []);
  const ownSamples = [...recSamples].filter((s) => !fileSamples.has(s));
  const goesLive = LIVE.test(fileRegion) && !LIVE.test(recRegion);
  if (goesLive || ownSamples.length) {
    const rj = markup(recRegion), fj = markup(fileRegion);
    const inter = [...rj].filter((l) => fj.has(l)).length;
    const jsx = rj.size && fj.size ? inter / (rj.size + fj.size - inter) : 0;
    if (jsx >= 0.6) {
      const what = goesLive
        ? "the file reaches live data (a Tauri `invoke` / the app store) where the record uses inert stand-ins"
        : `the record uses the sample constant(s) ${ownSamples.map((s) => `\`${s}\``).join(", ")}`;
      return (
        `Deliberate, not stale — preview DATA SUBSTITUTION. In \`${sym}\`, ${what}, because the preview ` +
        `mounts a record with no Tauri backend and no app store, so a live call would throw on mount. The ` +
        `RENDER layer still agrees (${(jsx * 100).toFixed(0)}% of markup lines shared), which is what says ` +
        `the divergence is confined to the data layer rather than the record being behind on UI. ` +
        `Refreshing from the file would import modules the loader cannot resolve and make the record ` +
        `un-previewable. Written by scripts/reconcile-record-src.cjs --annotate.`
      );
    }
    return null; // substituted AND the markup moved on — needs a human, not an annotation
  }

  // ── CLASS 1: PREVIEW PARAMETERIZATION ─────────────────────────────────────────────────────────────
  const added = defaultedParams(signatureOf(recRegion)).filter((n) => !defaultedParams(signatureOf(fileRegion)).includes(n));
  const states = /\b(loading|error)\b/.test(recRegion) && !/\b(loading|error)\b/.test(fileRegion);
  if (!added.length && !states) return null;

  const recLines = new Set(recRegion.split("\n").map((l) => l.trim()));
  const behind = fileRegion.split("\n").map((l) => l.trim())
    .filter((l) => l.length > 12 && !recLines.has(l) && !/^(import |\/\/|\*|\/\*)/.test(l)).length;
  if (behind > BEHIND_MAX) return null;

  const bits = [];
  if (added.length) bits.push(`defaults ${added.map((n) => `\`${n}\``).join(", ")}`);
  if (states) bits.push("adds loading/error states");
  // The residual is stated honestly. `behind` is under the threshold, NOT necessarily zero — and if the
  // file ever gained real behaviour, those lines are exactly where it would be. Saying "the file is not
  // ahead" would be a stronger claim than the check supports, and would send the next reader past it.
  const residual = behind === 0
    ? `Region-scoped check: the file's \`${sym}\` holds NO substantive line the record lacks, so nothing would be gained by refreshing and the parameterization would be lost.`
    : `Region-scoped check: the file's \`${sym}\` holds ${behind} substantive line(s) the record lacks — under the ${BEHIND_MAX}-line threshold at which parameterization stops being a full explanation, so it is treated as explained. NOT zero, though: if this component ever gained behaviour the record missed, those ${behind} line(s) are where to look.`;
  return (
    `Deliberate, not stale — preview parameterization. The record's \`${sym}\` ${bits.join(" and ")}, ` +
    `so it renders standalone in a preview that mounts records with no props; the file's takes them as ` +
    `required props from its caller. ${residual} Refreshing from the file would discard the ` +
    `parameterization. Written by scripts/reconcile-record-src.cjs --annotate.`
  );
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

// 0.35 was too permissive by exactly one case: `mcppage` re-pointed from the retired `McpWorkspace.tsx`
// to `features/mcp/index.tsx` at 0.419 — a BARREL, which shares a record's import block and little else,
// and which does not define `McpWorkspace` at all (the page is graph-hosted now, via `McpGraphHost`).
// `skillspage` scored similarly and was CORRECT, because `skills/index.tsx` really does define
// `SkillsWorkspace` — the file was merged into the barrel. So the score alone cannot separate them, and
// the symbol check below is what does: a re-point must land on a file that actually defines the record's
// symbol, or match it strongly enough (0.55) that a shared import block cannot account for it.
const REPOINT_MIN = 0.35;   // below this the winner is not really "the same module"
const REPOINT_LEAD = 1.5;   // and it must be this many times the runner-up
const REPOINT_NOSYM = 0.55; // required when the candidate does NOT define the record's symbol

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
    // A candidate that DEFINES the record's symbol is trusted at REPOINT_MIN; one that does not must clear
    // the higher bar, because a barrel shares a record's import block and can score respectably on that
    // alone (see REPOINT_NOSYM).
    const defines = best.rel && sym && (() => {
      try {
        const cs = fs.readFileSync(path.join(ROOT, best.rel), "utf8");
        return new RegExp(`\\b(?:function|const|class)\\s+${sym}\\b`).test(cs) || exportedSymbols(cs).has(sym);
      } catch { return false; }
    })();
    const floor = defines ? REPOINT_MIN : REPOINT_NOSYM;
    const confident = best.rel && best.score >= floor && best.score >= second.score * REPOINT_LEAD;
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

  // A RENAMED SYMBOL is not a moved one, and the difference decides whether anything gets rewritten.
  // The same prefix-drop wave that renamed `GitHubPulse.tsx` → `Pulse.tsx` also renamed the EXPORT:
  // `GitHubCrossRepoActivity` → `CrossRepoActivity`, `SkillsNewGroupDialog` → `NewGroupDialog`. The record
  // keeps its own name (its identity in the library), so looking the symbol up BY NAME finds nothing and
  // reads as "the component left this file" — when the pointer is already correct and only the export's
  // name changed. So when the name misses, ask which of the file's own definitions matches the record's
  // body; content identifies it where the name cannot.
  if (!stillHere && recLines.size) {
    let bestSym = null, bestScore = 0;
    for (const cand of exportedSymbols(fileSrc)) {
      const region = symbolRegion(fileSrc, cand);
      if (!region) continue;
      const s = similarity(recLines, lineSet(region));
      if (s > bestScore) { bestScore = s; bestSym = cand; }
    }
    if (bestSym && bestScore >= 0.4) {
      const recRegion = symbolRegion(rec.srcText ?? "", sym);
      const fileRegion = symbolRegion(fileSrc, bestSym);
      const rScore = recRegion && fileRegion ? similarity(lineSet(recRegion), lineSet(fileRegion)) : bestScore;
      const verdict = rScore >= DRIFT_MIN ? "ok" : "drifted";
      const reason = recRegion && fileRegion ? divergenceReason(recRegion, fileRegion, sym) : null;
      return { verdict, symbol: sym, renamedTo: bestSym, score: +score.toFixed(3), region: +rScore.toFixed(3), by: "renamed-symbol", reason };
    }
  }

  if (!stillHere) {
    const { best, second } = bestMatch(recLines, files);
    const confident = best.rel && best.rel !== src && best.score >= REPOINT_MIN && best.score >= second.score * REPOINT_LEAD;
    return {
      verdict: "moved", symbol: sym, score: +score.toFixed(3),
      best: best.rel, bestScore: +best.score.toFixed(3),
      runnerUp: second.rel, runnerUpScore: +second.score.toFixed(3), confident: !!confident,
    };
  }

  // The symbol is in BOTH — so compare DEFINITION to DEFINITION. This is the only comparison that is not
  // swamped by vendoring and lifting (see `symbolRegion`), and it is what decides drift.
  const fileRegion = symbolRegion(fileSrc, sym);
  const recRegion = symbolRegion(rec.srcText ?? "", sym);
  if (fileRegion && recRegion) {
    const rScore = similarity(lineSet(recRegion), lineSet(fileRegion));
    if (rScore >= DRIFT_MIN) return { verdict: "ok", symbol: sym, score: +score.toFixed(3), region: +rScore.toFixed(3), by: "region" };
    // Drifted — but is the difference explainable, and evidenced? `--annotate` writes the reason.
    const reason = divergenceReason(recRegion, fileRegion, sym);
    return { verdict: "drifted", symbol: sym, score: +score.toFixed(3), region: +rScore.toFixed(3), by: "region", reason };
  }
  return { verdict: "drifted", symbol: sym, score: +score.toFixed(3) };
}

function main() {
  const seed = loadSeed();
  const files = indexSourceFiles();
  const rows = [];
  let repointed = 0;
  let annotated = 0;
  let retired = 0;

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
    if (RETIRE && res.verdict === "stale-pointer" && !res.confident && rec.src && !rec.srcRetired) {
      // The file is gone and nothing in src/ matches this record, so there is nothing to re-point TO.
      // `src` goes null (the convention for a superseded page) and the path it named is preserved in
      // `srcRetired` — nulling alone would throw away the one fact a later reader needs.
      rec.srcRetired = rec.src;
      delete rec.src;
      fs.writeFileSync(entry.file, JSON.stringify(rec, null, 2) + "\n", "utf8");
      row.retiredFrom = row.src;
      retired++;
    }
    if (ANNOTATE && res.verdict === "drifted" && res.reason && !rec.srcDivergence) {
      rec.srcDivergence = res.reason;
      fs.writeFileSync(entry.file, JSON.stringify(rec, null, 2) + "\n", "utf8");
      row.annotated = true;
      annotated++;
    }
    rows.push(row);
  }

  const counts = rows.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  const summary = { total: rows.length, counts, repointed, annotated, retired, applied: APPLY, annotateMode: ANNOTATE };

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
    for (const r of drifted.sort((a, b) => (a.region ?? a.score) - (b.region ?? b.score))) {
      console.log(`  region=${String(r.region ?? "?").padEnd(6)} ${r.id.padEnd(30)} ${r.reason ? "explained" : "NEEDS VERDICT"}  ${r.src}`);
    }
    const explained = drifted.filter((r) => r.reason).length;
    console.log(`\n  ${explained} EXPLAINED — preview parameterization, evidenced per record. \`--annotate\` writes`);
    console.log(`  the reason to \`srcDivergence\`, which moves them to the \`intentional\` verdict.`);
    console.log(`  ${drifted.length - explained} NOT explained — each needs a human verdict. Refresh is the EXCEPTION:`);
    console.log(`  the record is frequently the RICHER copy (see \`divergenceReason\`).`);
  }
  console.log("");
}

main();
