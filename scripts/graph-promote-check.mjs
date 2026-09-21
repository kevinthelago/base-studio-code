#!/usr/bin/env node
/**
 * `node scripts/graph-promote-check.mjs` — the gate's half of the repo-store seam.
 *
 * Under files-to-zero the build compiles from `graph/algorithms.json`, a COMMITTED file, while authoring
 * happens in the per-user runtime store. `bsc algorithms promote` moves records across, and that seam has a
 * drift surface by construction: an author can edit a record and never promote it, leaving the thing the
 * compiler reads silently behind the thing the author believes is current. This is the check for it.
 *
 * # Why this exits 0 when it cannot check
 *
 * Two cases are NOT failures, and conflating either with a red node would make the gate lie:
 *
 *  * **No `bsc` binary.** A fresh clone has not built one yet. The check is infrastructure; its absence
 *    is reported loudly on stdout and the gate moves on. (A compile failure is never treated this way —
 *    see the sweep, which fails hard.)
 *  * **No runtime store.** A machine that never authored these records has no opinion about whether the
 *    committed ones are stale. `bsc algorithms promote --check` already returns `checked: 0` there; this
 *    wrapper just does not invent a failure around it.
 *
 * What DOES fail: a record that exists in both stores and differs. That is an edit which never reached
 * the compiler, and the underlying verb names the ids.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";
import { loadStore, resolveStorePath, isSqliteStore } from "./lib/recordStore.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");


/** The drifted ids out of `promote --check`'s JSON line, or `[]` when it did not emit one. */
export function drifted(stdout) {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const d = JSON.parse(t);
      if (Array.isArray(d.drifted)) return d.drifted;
    } catch {
      // A non-JSON line is the human message beside it, not a parse failure worth reporting.
    }
  }
  return [];
}

/**
 * The wall-clock bound for the underlying `bsc algorithms promote --check`, in milliseconds.
 *
 * This leg execs a `bsc` subcommand that compares the committed store against the SHARED runtime store
 * every concurrent session authors. MEASURED 2026-09-07: at store size 1395, with ~13 sessions
 * authoring at once, that comparison spun ON-CPU for 32+ minutes (a healthy run is ~37s) — and
 * `gate.mjs` epoll-waited on it the whole time HOLDING the single full-gate slot lock, so every other
 * session's `--full` gate blocked behind it (request #253). A gate leg that can hang unboundedly and
 * starve a shared slot is the failure this bound exists to stop.
 *
 * Configurable via `BSC_PROMOTE_CHECK_TIMEOUT_MS`; the default (180s) sits well ABOVE the ~37s a healthy
 * run takes — so an honestly-slow check is never cut off — and far BELOW the 32-minute spin that starved
 * the slot. A non-positive or unparseable value falls back to the default rather than DISABLING the
 * bound: a check with no bound is exactly the bug, so "junk" must never mean "run forever".
 */
export const PROMOTE_CHECK_DEFAULT_TIMEOUT_MS = 180_000;

/** How many drifted ids to attribute IN DETAIL before truncating (request #253). A red run under heavy
 *  concurrent authoring can carry hundreds of drifted ids (MEASURED 344); the check's JSON already NAMES
 *  every one, so the per-id blame is diminishing signal past a couple dozen — and each entry shells out
 *  to git + `bsc`. This caps the noise; the wall-clock deadline is the hard stop on top of it. */
export const PROMOTE_CHECK_DETAIL_CAP = 25;

// ── THE FILTERS (request #317) ───────────────────────────────────────────────────────────────────
//
// THE FAILURE THEY EXIST FOR, measured 2026-09-12. This leg capped per-id DETAIL at 25 and then
// printed the underlying verb's own failure message, which names EVERY drifted id in one
// comma-separated blob — 434 of them, 9.4 KB on one line, beside a 25-entry detail section. A reader
// reviewing a lane's merge read the 25, concluded none of that lane's records were drifted, and was
// WRONG: six of its eleven were among the 409 the detail never reached. A complete list nobody can
// read, next to a truncated list that looks complete, is worse than either alone.
//
// So the full set stops being the DEFAULT way the answer is conveyed, and the narrow questions get
// verbs of their own. FILTERS, NOT PAGINATION (maintainer, explicit): there is no `--page`/`--offset`,
// because a page is just a smaller blob that still makes the reader do the joining.
//
// Every one of these is OPT-IN. The gate leg invokes this file with NO arguments, the exit codes are
// untouched (0 clean · 1 drift · 3 timeout · 4 coverage shortfall), and `gate.mjs` inherits stdio and
// records pass/fail from the exit status rather than parsing a line of this — so none of it can move
// what the gate concludes.
export const PROMOTE_CHECK_FILTERS = ["--count", "--ids", "--json", "--mine", "--author", "--id"];

/**
 * The filter flags out of an argv tail. An UNRECOGNISED flag is collected, never ignored.
 *
 * Silently ignoring an unknown flag is how a reader ends up trusting an answer to a question they did
 * not ask: `--auther claude` would otherwise print the whole unfiltered report and look like a filtered
 * one. The CLI refuses on a non-empty `unknown`.
 */
export function parseFilters(argv = []) {
  const out = { count: false, ids: false, json: false, mine: false, author: null, named: null, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    switch (a) {
      case "--count": out.count = true; break;
      case "--ids": out.ids = true; break;
      case "--json": out.json = true; break;
      case "--mine": out.mine = true; break;
      case "--author": {
        const v = value();
        if (v === null) out.unknown.push("--author (needs a value)");
        else out.author = v;
        break;
      }
      case "--id": {
        const v = value();
        if (v === null) out.unknown.push("--id (needs a value)");
        else out.named = (out.named ?? []).concat(v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      default: out.unknown.push(a);
    }
  }
  return out;
}

/**
 * WHO `--mine` means, from the same source the writes are stamped with — or null.
 *
 * `bsc_record::resolve_writer` stamps `updatedBy` from `--by`, else `$BSC_UI_WRITER`, else the literal
 * string `"unknown"`. So `$BSC_UI_WRITER` is the only identity a filter can honestly match on, and
 * `"unknown"` is NOT an identity: 6,381 of the runtime ledger's rows carry it, and treating it as one
 * would answer "yours" with almost the whole store.
 *
 * NULL IS THE REFUSAL, and the CLI exits non-zero on it rather than filtering to nothing. An
 * unresolvable identity that reported an empty match would print "none of yours drifted" — which is
 * the exact false clean this whole request exists to stop.
 */
export function resolveMine(env = {}) {
  const who = String(env.BSC_UI_WRITER ?? "").trim();
  return who === "" || who.toLowerCase() === "unknown" ? null : who;
}

/**
 * The CLOSED question `--id` asks: are THESE ids drifted, saying nothing about any other.
 *
 * This is the shape the failure called for. The reader had eleven record ids in hand and wanted a yes
 * or no about those eleven; what the leg offered was a 434-id blob to search by eye.
 */
export function verdictForIds(named, driftedIds) {
  const set = new Set(driftedIds);
  return { drifted: named.filter((id) => set.has(id)), clean: named.filter((id) => !set.has(id)) };
}

/**
 * The drifted ids attributable to ONE author, plus the coverage that says what the filter could not see.
 *
 * `unattributed` is the load-bearing return value, not a detail. Most of this ledger's rows are stamped
 * `unknown` (measured: 6,381 of 6,459), so a bare "0 matched" is indistinguishable from "0 of the ones
 * that CAN be attributed" — and this repo's signature failure is a measurement reporting an absence
 * that reads as a clean result. The caller prints it alongside every answer.
 *
 * `truncated` is the same rule applied to the wall-clock bound: `historyFor` shells out per id, so a
 * long run stops at the leg deadline, and a stopped filter must say it is INCOMPLETE rather than
 * report what it happened to reach.
 */
export function selectByAuthor(ids, historyFor, who, opts = {}) {
  const { deadlineMs } = opts;
  const want = String(who).trim().toLowerCase();
  const matched = [];
  let unattributed = 0;
  let unreadable = 0;
  let considered = 0;
  for (const id of ids) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    considered += 1;
    const h = historyFor(id);
    if (!h) { unreadable += 1; continue; }
    const by = String(h.updatedBy ?? "").trim();
    if (by === "" || by.toLowerCase() === "unknown") { unattributed += 1; continue; }
    if (by.toLowerCase() === want) matched.push(id);
  }
  return { matched, unattributed, unreadable, considered, truncated: ids.length - considered };
}

/** What an author-filtered answer must say about its own blind spots, so an empty match is readable. */
export function authorCoverage(sel, total, who) {
  const lines = [
    `  matched ${sel.matched.length} of the ${total} drifted id(s), attributed to ${who}.`,
  ];
  if (sel.unattributed > 0) {
    lines.push(
      `  ${sel.unattributed} of the ${sel.considered} examined carry NO author stamp (updatedBy is empty or`,
      "  `unknown`), so this filter cannot see them either way. An empty match is not a clean bill.",
    );
  }
  if (sel.unreadable > 0) lines.push(`  ${sel.unreadable} could not be read from the runtime store at all.`);
  if (sel.truncated > 0) {
    lines.push(
      `  INCOMPLETE: stopped ${sel.truncated} id(s) short of the full set on the wall-clock bound.`,
      "  This answer is a floor, not a verdict — re-run it with a larger BSC_PROMOTE_CHECK_TIMEOUT_MS.",
    );
  }
  return lines.join("\n");
}

/**
 * The default drift headline — what REPLACED the 434-id blob.
 *
 * It states the count and then routes the reader to a narrower question instead of handing them the
 * set. The set is still reachable (`--ids`, `--json`); it simply stops being the thing you get when
 * you did not ask, because that is what made a truncated detail section read as a complete report.
 */
export function driftHeadline(total) {
  return `${[
    "",
    `graph: the repo store is out of date — ${total} record(s) drifted.`,
    `  The ids are NOT listed here. A ${total}-id blob beside a ${PROMOTE_CHECK_DETAIL_CAP}-entry detail section reads as a`,
    "  complete report and is not: six of one lane's eleven records once sat in the part the detail",
    "  never reached, and the reader concluded none of them had drifted. Ask a narrower question:",
    "    --count                    how many, and nothing else",
    "    --id <id>[,<id>…]          are THESE drifted? (exits 0 when none of the named ones are)",
    "    --mine | --author <who>    the slice attributable to one author, with its blind spots named",
    "    --ids                      every drifted id, one per line, when you do want them all",
    "    --json                     the check's own machine-readable line, unchanged",
  ].join("\n")}\n`;
}

export function promoteCheckTimeoutMs(env = {}) {
  const raw = env.BSC_PROMOTE_CHECK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return PROMOTE_CHECK_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : PROMOTE_CHECK_DEFAULT_TIMEOUT_MS;
}

/**
 * The LOUD verdict printed when the check is aborted on its wall-clock bound.
 *
 * It says the seam was NOT verified — never that it is clean. A timeout is not a pass: it is a check
 * that could not check, and conflating the two would make the gate lie in exactly the way this repo
 * keeps getting caught by. The CLI exits NON-ZERO alongside this, so it reads red in the gate.
 */
export function promoteCheckTimeoutVerdict(ms, signal, error) {
  const timedOut = error?.code === "ETIMEDOUT" || (signal && !error);
  const detail = timedOut
    ? `exceeded its ${Math.round(ms / 1000)}s wall-clock bound`
    : `was terminated (${signal || error?.code || "unknown"})`;
  return `${[
    "",
    `graph: TIMED OUT — repo-store drift was NOT verified (${detail}).`,
    "  `bsc algorithms promote --check` compares the committed store against the SHARED runtime store that",
    "  every concurrent session authors; under heavy concurrent authoring it can spin far past its",
    "  normal ~37s. This leg was aborted so it could NOT hold the full-gate slot (request #253).",
    "  This is NOT a pass. Re-run the gate when the box is quieter, or raise",
    "  BSC_PROMOTE_CHECK_TIMEOUT_MS if a healthy check legitimately needs longer.",
  ].join("\n")}\n`;
}

/** `<n> seconds/minutes/hours/days ago`, or null for an unparseable/absent stamp. */
export function ago(iso, nowMs) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Name WHO and WHEN for each drifted node.
 *
 * The bare failure says only "the repo store is out of date — run `bsc algorithms promote`", and following
 * that advice blind is how someone else's HALF-WRITTEN record reaches the build's source of truth. This
 * check compares a git-tracked file against a SHARED, MUTABLE runtime store that every concurrent
 * session writes to, so a red is often not stale drift at all — it is another session authoring right
 * now. MEASURED 2026-09-01: a full gate went red on `session-roles.ts` 31 seconds after another session
 * wrote it, three revisions inside two seconds. The age is what separates the two cases, and it is the
 * difference between "promote this" and "leave it alone, someone is mid-edit".
 *
 * `unknown` is printed as-is rather than hidden: an unattributed write is itself the finding, and that
 * is what `fleet-director-bridge.ts` had — rev 0, no author, no timestamp, unowned for weeks.
 */
export function attribute(ids, historyFor, nowMs, opts = {}) {
  if (ids.length === 0) return "";
  const { limit = Infinity, deadlineMs } = opts;
  const lines = ["", "who last authored each drifted node (from the RUNTIME store, which is shared):"];
  let fresh = false;
  let done = 0;
  for (const id of ids) {
    // BOUND THE LOOP. `historyFor` shells out to `bsc` per id; with hundreds of drifted ids under heavy
    // concurrent authoring that aggregate is unbounded (request #253). Stop at a count cap or a wall-clock
    // deadline and say so — every drifted id is still named in the check's own JSON above, so truncating
    // this per-id detail loses no finding, only the noise of attributing 344 records nobody will read.
    if (done >= limit || (deadlineMs && Date.now() > deadlineMs)) {
      lines.push(`  … stopped after ${done} of ${ids.length} (${done >= limit ? "detail cap" : "time budget"}); the rest are NOT named anywhere in this report — ask \`--ids\`, \`--author <who>\` or \`--id <id>\`.`);
      break;
    }
    done += 1;
    const h = historyFor(id);
    if (!h) {
      lines.push(`  ${id} — no history available`);
      continue;
    }
    const when = ago(h.updatedAt, nowMs);
    if (when && nowMs - Date.parse(h.updatedAt) < 300_000) fresh = true;
    lines.push(`  ${id} — rev ${h.rev ?? "?"} by ${h.updatedBy || "unknown"}${when ? `, ${when}` : ", never stamped"}`);
  }
  if (fresh) {
    lines.push(
      "",
      "  One of these was authored in the last 5 minutes: ANOTHER SESSION IS PROBABLY MID-EDIT.",
      "  Do NOT `bsc algorithms promote` it — that commits their in-flight record to the build's source of truth.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One record's runtime provenance, or null when it cannot be read (never fatal — this is a diagnostic). */
function history(bsc, id) {
  try {
    return JSON.parse(execFileSync(bsc, ["algorithms", "impl", "history", id], { encoding: "utf8", timeout: 10_000 }));
  } catch {
    return null;
  }
}

/** The record fields whose VALUES differ, ignoring the server-managed stamps the check already skips. */
const STAMPS = new Set(["rev", "updatedAt", "updatedBy", "history", "build"]);

/**
 * WHAT drifted, not merely that something did.
 *
 * The bare check names an id, and an id alone cannot separate the two cases that matter: a real edit
 * waiting to be promoted, and a record the runtime store should never have been holding. MEASURED
 * 2026-09-01 — `session-roles.ts` drifted because a bsc-graph TEST wrote its fixture into the real
 * per-user store through an unlocked `BSC_GRAPH_STORE`. Its runtime `code` was 33 characters against
 * the repo's 3263. Promoting that id, which is what the bare failure message advises, would have
 * written the stub over the record permanently.
 *
 * `collapsed` is the signal for exactly that: the runtime copy is a small fraction of the committed
 * one. It is deliberately a RATIO rather than a search for the fixture marker that leaked this time —
 * the next leaked fixture will carry a different marker and the same shape.
 */
export function shapeOf(runtime, repo) {
  if (!runtime || !repo) return null;
  const fields = [...new Set([...Object.keys(runtime), ...Object.keys(repo)])]
    .filter((k) => !STAMPS.has(k))
    .filter((k) => JSON.stringify(runtime[k]) !== JSON.stringify(repo[k]))
    .sort();
  const runtimeCode = typeof runtime.code === "string" ? runtime.code.length : null;
  const repoCode = typeof repo.code === "string" ? repo.code.length : null;
  // 200 chars is the floor below which a ratio means nothing — a two-line helper legitimately
  // shrinking by half is not evidence of a leaked fixture.
  const collapsed = repoCode !== null && runtimeCode !== null && repoCode > 200 && runtimeCode * 4 < repoCode;
  return { fields, runtimeCode, repoCode, collapsed };
}

/**
 * The commit that last authored `id` in the COMMITTED store — the acceptance criterion the original
 * item asked for and that is still missing after the runtime-side attribution landed.
 *
 * Runtime attribution answers "who wrote the copy that drifted"; on this repo it answered `unknown`,
 * because the writer was a test. The repo side stays answerable whatever the runtime store does:
 * `graph/algorithms.json` is git-tracked, so the record has a real commit, author and message.
 *
 * Walks newest-first and stops at the first commit where the record differs from its predecessor's —
 * that commit CHANGED it, as opposed to the many that merely touched the 2.3 MB file around it.
 * `limit` bounds the walk: this runs only on a failure, but 62 commits x 2.3 MB is not a cost to pay
 * silently, and a walk that runs off the end says so rather than claiming nothing changed the record.
 */
export function lastRepoCommit(id, commits, recordAt, limit = 40) {
  const window = commits.slice(0, limit);
  if (window.length === 0) return null;
  let current = recordAt(window[0].sha);
  for (let i = 0; i < window.length; i += 1) {
    const prev = i + 1 < window.length ? recordAt(window[i + 1].sha) : null;
    if (JSON.stringify(current) !== JSON.stringify(prev)) {
      return { ...window[i], exhausted: i + 1 >= window.length && commits.length > limit };
    }
    current = prev;
  }
  return null;
}

/**
 * Whether the verb's own report says it actually checked the store — the COVERAGE guard.
 *
 * `checked` is `tracked_ids(repo).len() + edge_ids.len()`, so `checked - checkedEdges` must equal the
 * number of implementations in the merged committed store. Anything less is a check that verified a
 * fraction of the seam and reported `ok: true` about the rest.
 *
 * THIS IS NOT HYPOTHETICAL, and it passed a full gate. `target/debug/bsc` was a ZERO-BYTE file (what a
 * binary IS for the seconds it is being linked), so `pickUsable` correctly rejected it and fell through
 * to the STALE staged `~/.base-studio-code/bin/bsc` — which predates the per-record split and reads only
 * the store FILE. That file now holds no implementations, so the stale binary found `tracked: 0`,
 * checked the 8 edges, and reported the repo store current. Rebuilt, the same check covered 1,734 and
 * found real drift.
 *
 * A version handshake would NOT have caught it: the binary answered `version` perfectly well: it was
 * current for its own build and simply older than the layout. What separates the two is how much it
 * says it looked at.
 */
export function coverageShortfall(report, storeRecords) {
  if (!report || typeof report.checked !== "number") return null;
  const impls = report.checked - (report.checkedEdges ?? 0);
  if (impls >= storeRecords) return null;
  return { checked: impls, expected: storeRecords };
}

/** The repo-side attribution + drift shape for each drifted id, as printable lines. */
export function diagnose(ids, io, opts = {}) {
  if (ids.length === 0) return "";
  const { limit = Infinity, deadlineMs } = opts;
  const lines = ["", "what drifted, and who last authored it in the COMMITTED store:"];
  let collapsed = false;
  let done = 0;
  for (const id of ids) {
    // BOUND THE LOOP — this is the DOMINANT cost of a red run (request #253). Per id, `io.blame` walks
    // the git history of the ~2 MB committed store; with hundreds of drifted ids (the shape of heavy
    // concurrent authoring — MEASURED 344 at once) that is thousands of full-file `git show`s + JSON
    // parses, which is the real 32-minute spin. Stop at a count cap or a deadline; the ids are all named
    // in the check's JSON above, so this truncates detail, not the finding.
    if (done >= limit || (deadlineMs && Date.now() > deadlineMs)) {
      lines.push(`  … stopped after ${done} of ${ids.length} (${done >= limit ? "detail cap" : "time budget"}); the rest are NOT named anywhere in this report — ask \`--ids\`, \`--author <who>\` or \`--id <id>\`.`);
      break;
    }
    done += 1;
    const shape = shapeOf(io.runtime(id), io.repo(id));
    const commit = io.blame(id);
    lines.push(`  ${id}`);
    lines.push(
      commit
        ? `    repo store: last changed by ${commit.sha} (${commit.author}, ${commit.date}) ${commit.subject}` +
            (commit.exhausted ? "  [oldest commit examined — the real one may be older]" : "")
        : "    repo store: no commit in the examined window changed this record",
    );
    if (!shape) {
      lines.push("    drift: one of the two copies could not be read, so the shape is unknown");
      continue;
    }
    const code =
      shape.repoCode !== null && shape.runtimeCode !== null ? `code ${shape.repoCode} -> ${shape.runtimeCode} chars` : null;
    const changed = [code, ...shape.fields.filter((f) => f !== "code")].filter(Boolean);
    lines.push(`    drift: ${changed.length ? changed.join(", ") : "(no field differs)"}`);
    if (shape.collapsed) {
      collapsed = true;
      lines.push(
        "    ⚠ the RUNTIME copy is a fraction of the committed one. That is the shape of a TEST that",
        "      wrote into the real store, not of an edit.",
      );
    }
  }
  if (collapsed) {
    lines.push(
      "",
      "  DO NOT `bsc algorithms promote` a collapsed node — that writes the stub over the record permanently.",
      "  Restore the runtime copy from the committed one instead, then re-run this check.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One record out of the RUNTIME store, or null (never fatal — this is a diagnostic). */
function impl(bsc, id) {
  try {
    return JSON.parse(execFileSync(bsc, ["algorithms", "impl", "get", id], { encoding: "utf8", timeout: 10_000 }));
  } catch {
    return null;
  }
}

/** One record out of the COMMITTED store on disk — the store file MERGED with `graph/records/*.json`. */
function repoRecord(root, id) {
  try {
    return pick(loadStore(resolveStorePath(root)), id);
  } catch {
    return null;
  }
}

/**
 * The commits that changed `id`'s OWN file, newest first — empty when the record has no file yet.
 *
 * This is the whole reason the per-record split is worth doing to THIS script. `lastRepoCommit` below
 * exists because the monolith gave a record no history of its own: every commit touching any of 1,700
 * records touched the same 27 MB file, so answering "who last changed this record" meant `git show`ing
 * the whole store at up to 40 commits and diffing the record out of each. MEASURED as the dominant
 * cost of a red run — 344 drifted ids made it a 32-minute spin (request #253).
 *
 * With `graph/records/<id>.json` the question is just `git log` on one small path, and the FIRST
 * result is the answer: no walk, no diff, no cap. `epic-retire-json-ledgers-for-db-and-git-drivers`.
 */
function commitsTouchingRecordFile(root, id) {
  try {
    const out = execFileSync(
      "git",
      [
        "log",
        "--format=%h%x1f%an%x1f%ad%x1f%s",
        "--date=short",
        // MODIFICATIONS ONLY. Every record file was ADDED by the one commit that split the store, so
        // without this every record blames that commit and the answer is useless — worse than the walk
        // it replaces, which at least found the change. A record MODIFIED since the split has a real
        // answer here; one that has not been touched falls through to the monolith walk below, which
        // is where its history actually lives.
        "--diff-filter=M",
        "--",
        `graph/records/${id}.json`,
      ],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split("\x1f");
        return { sha, author, date, subject };
      });
  } catch {
    return [];
  }
}

/** The commits that touched the committed store, newest first. */
function commitsTouchingStore(root) {
  try {
    const out = execFileSync("git", ["log", "--format=%h%x1f%an%x1f%ad%x1f%s", "--date=short", "--", "graph/algorithms.json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split("\x1f");
        return { sha, author, date, subject };
      });
  } catch {
    return [];
  }
}

/**
 * One record as it stood at `sha`, or null when it did not exist there / could not be parsed.
 *
 * The record's OWN file first — one small `git show` rather than 27 MB — falling back to the monolith
 * for a record that has not been split out (and for history from before the split).
 */
function recordAtCommit(root, sha, id) {
  const show = (path, budget) =>
    execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: budget,
    });
  try {
    return JSON.parse(show(`graph/records/${id}.json`, 8 * 1024 * 1024));
  } catch {
    // not split out at that commit — fall through to the whole store
  }
  return pick(monolithAtCommit(root, sha, show), id);
}

/**
 * The whole committed store as it stood at `sha`, MEMOIZED by sha for the life of the process.
 *
 * The walk is per-ID but the blob is not, and that asymmetry is the leg's known pathology: at 25 ids
 * over a 40-commit window it was 1,000 `git show`s of a 27 MB file (request #253's 32-minute spin).
 * One parse per commit serves every id — 40 instead of 1,000 — and the window is bounded, so the cache
 * is bounded with it.
 *
 * `null` is CACHED too, so a commit from before the file existed is not re-fetched once per id.
 */
const MONOLITH_AT = new Map();
function monolithAtCommit(root, sha, show) {
  if (MONOLITH_AT.has(sha)) return MONOLITH_AT.get(sha);
  let doc;
  try {
    // The MONOLITH, by its historical name. This is a look BACKWARDS through git at a file that may no
    // longer exist in the working tree — under `retire-the-committed-json-record-store` the store is a
    // database — so an absent file here is ordinary history, not an error. It is cached as `null` and
    // the caller falls back to the per-record view.
    doc = JSON.parse(show("graph/algorithms.json", 64 * 1024 * 1024));
  } catch {
    doc = null;
  }
  MONOLITH_AT.set(sha, doc);
  return doc;
}

/** The `id` record out of a parsed store document. */
function pick(doc, id) {
  const all = Array.isArray(doc?.implementations) ? doc.implementations : [];
  return all.find((r) => r?.id === id) ?? null;
}

// ── THE CLI ENTRY POINT — DELIBERATELY LAST IN THE FILE ──────────────────────────────────────────
//
// It USED to sit here at line 32, directly under the imports, and that placement was a latent crash.
// This block runs during MODULE EVALUATION, so it reached `diagnose` -> `shapeOf` 84 lines before
// `const STAMPS` was initialized, and every real drift ended in:
//
//     ReferenceError: Cannot access 'STAMPS' before initialization
//
// SIX TESTS COVER `diagnose` AND `shapeOf` AND NONE COULD SEE IT. Under vitest `process.argv[1]` is
// the vitest runner, so this block never executed: the module finished evaluating, `STAMPS`
// initialized, and only then did a test call `diagnose`. The tests exercise these functions in an
// order the CLI never uses — a green suite covering strictly less than the live path.
//
// What died was the SAFETY half. `attribute` (author + age) ran first and printed; `shapeOf`'s
// `collapsed` signal did not. That signal exists because a bsc-graph test once wrote a 33-character
// stub over a 3,263-character record through an unlocked `BSC_GRAPH_STORE`, and promoting that id —
// exactly what the bare failure message advises — would have destroyed the record permanently. So a
// reader hit the red, was told to promote, and was NOT told not to.
//
// KEEP THIS BLOCK BELOW EVERY DECLARATION IT REACHES. `scripts/graph-promote-check.test.ts` pins it
// by SPAWNING this file as a CLI rather than importing it, because an in-process import structurally
// cannot reproduce the failing order.
if (process.argv[1]?.endsWith("graph-promote-check.mjs")) {
  // Resolution is SHARED with `bsc-doctor` (scripts/lib/bscBinary.mjs) rather than duplicated: a second
  // copy of "is this binary usable" is exactly how one of them ends up not knowing about the zero-byte
  // case. `pickUsable` demands a real handshake, not mere existence.
  const statSize = (p) => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  };
  const run = (p) => {
    try {
      return { status: 0, stdout: execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
    }
  };

  const usable = pickUsable(candidatePaths(ROOT, homedir(), join), { statSize, run });
  if (!usable) {
    process.stdout.write(
      "graph: no usable `bsc` binary — repo-store drift NOT checked. " +
        "Run `npm run bsc:doctor` to see why, then `cargo build -p bsc --bin bsc`.\n",
    );
    process.exit(0);
  }
  // WALL-CLOCK BOUND on the check itself (request #253). `spawnSync` rather than `execFileSync`
  // because it RETURNS the timeout outcome (signal + ETIMEDOUT) instead of throwing an error that reads
  // identically to a real drift. On the bound the child is SIGKILL'd — the pathology is a CPU-bound
  // spin and a spinning process can be slow to honour SIGTERM; the check only READS the stores, so a
  // hard kill loses no in-flight write. Exiting here is what frees the shared gate slot: `gate.mjs`
  // releases it the instant this leg's process returns, so a leg that always terminates can never
  // starve the fleet the way the 32-minute spin did.
  const timeoutMs = promoteCheckTimeoutMs(process.env);
  // ONE deadline for the WHOLE leg — the check plus the diagnostics below. The check gets the full
  // budget; whatever it leaves is what the per-id diagnostics may spend before they truncate. This is
  // the guarantee the request asks for: the leg terminates within roughly `timeoutMs`, freeing the slot.
  const legDeadlineMs = Date.now() + timeoutMs;
  const r = spawnSync(usable.path, ["algorithms", "promote", "--check", "--root", ROOT], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  // `signal`/`error` are set ONLY when the child was KILLED or failed to run rather than exiting on its
  // own. A real drift EXITS with status 1 and a null signal, so the abort case and the drift case never
  // collide — the timeout is reported as its own verdict, not misread as clean.
  if (r.signal || r.error) {
    process.stdout.write(String(r.stdout ?? ""));
    process.stderr.write(String(r.stderr ?? ""));
    process.stdout.write(promoteCheckTimeoutVerdict(timeoutMs, r.signal, r.error));
    // NON-ZERO on purpose: a timeout DID NOT VERIFY the seam, and a check that cannot check must not
    // read as a pass. Exit 3 (distinct from 1 = real drift) so the two are separable in a log.
    process.exit(3);
  }
  if (r.status === 0) {
    const out = String(r.stdout ?? "");
    process.stdout.write(out.trim() ? `${out.trim()}\n` : "graph: repo store is current\n");
    // A CLEAN VERDICT IS ONLY WORTH WHAT IT COVERED. See `coverageShortfall` — a stale `bsc` reading
    // only the store file reports the seam current after checking 8 of 1,734.
    const parse = (text) => {
      try {
        return JSON.parse(text.trim().split("\n").pop() ?? "");
      } catch {
        return null;
      }
    };
    const storeRecords = () => {
      try {
        return (loadStore(resolveStorePath(ROOT)).implementations ?? []).length;
      } catch {
        return 0;
      }
    };
    const expected = storeRecords();
    const short = expected > 0 ? coverageShortfall(parse(out), expected) : null;
    if (short) {
      process.stdout.write(
        `\ngraph: REFUSING a clean verdict — \`bsc algorithms promote --check\` covered ${short.checked} ` +
          `implementation(s) of the ${short.expected} this checkout's committed store holds.\n` +
          `  The binary at ${usable.path} disagrees with this script about what the store IS. The usual ` +
          `cause is a stale one: records live one-per-file under \`graph/records/\` and a binary from ` +
          `before that reads only \`graph/algorithms.json\`, which now holds none of them.\n` +
          // NAME THE RIGHT REMEDY FOR THE PATH IT ACTUALLY USED. These are different commands, and a
          // reader told to rebuild `target/debug/bsc` when the binary in play is the SHARED STAGED one
          // will rebuild, see no change, and conclude the guard is broken. `pickUsable` falls through
          // to the staged copy whenever this tree's own binary is missing or zero-byte — which is what
          // a binary IS while it is being linked, and is how this leg came to run against a stale
          // `bsc` without anyone noticing.
          (usable.path.includes(`${sep}.base-studio-code${sep}bin${sep}`)
            ? `  That is the SHARED STAGED binary, which every session on this box uses. Refresh it: npm run build:plan\n` +
              `  (this tree's own target/debug/bsc was missing or zero-byte, so resolution fell through to it)\n`
            : `  Rebuild it: cargo build -p bsc --bin bsc\n`),
      );
      // Exit 4 — distinct from 1 (real drift) and 3 (timeout), because this is neither: the seam was
      // NOT verified, and a check that could not check must not read as a pass.
      process.exit(4);
    }
    process.exit(0);
  }
  // A genuine drift: non-zero exit carrying the JSON line the underlying verb emitted.
  //
  // THE CHILD'S OWN OUTPUT IS NO LONGER ECHOED BY DEFAULT (request #317). Both halves of it name every
  // drifted id — a 51 KB JSON line on stdout and a 9.4 KB comma-separated sentence on stderr, measured
  // on a 434-id run — and that blob beside a 25-entry detail section is what made a truncated report
  // read as a complete one. Both are still reachable, by asking: `--json` for the machine line verbatim,
  // `--ids` for the set. Nothing PARSES this leg's stdout (`gate.mjs` inherits stdio and records the
  // exit status), so what changes here is what a human is handed, not what any script consumes.
  const rawOut = String(r.stdout ?? "");
  const ids = drifted(rawOut);
  const filters = parseFilters(process.argv.slice(2));
  if (filters.unknown.length > 0) {
    process.stderr.write(
      `graph-promote-check: unrecognised argument(s): ${filters.unknown.join(", ")}\n` +
        `  known filters: ${PROMOTE_CHECK_FILTERS.join(" ")}\n` +
        "  Refusing rather than ignoring them: an ignored filter prints the WHOLE report and looks\n" +
        "  exactly like a filtered one, which is the misreading this surface exists to prevent.\n",
    );
    process.exit(2);
  }
  // The machine line, byte for byte as the verb emitted it — the unchanged contract, now on request.
  if (filters.json) {
    const line = rawOut.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "";
    process.stdout.write(`${line}\n`);
    process.exit(1);
  }
  if (filters.count) {
    process.stdout.write(`graph: ${ids.length} drifted\n`);
    process.exit(1);
  }
  if (filters.ids) {
    for (const id of ids) process.stdout.write(`${id}\n`);
    process.exit(1);
  }
  // The CLOSED question: are THESE drifted? It is the only filter that changes the exit code, because
  // it is the only one asking about a named set rather than narrowing a report of the whole store.
  if (filters.named) {
    const v = verdictForIds(filters.named, ids);
    process.stdout.write(
      `${[
        `graph: ${v.drifted.length} of the ${filters.named.length} id(s) named are drifted` +
          ` (the store holds ${ids.length} drifted in total, not listed here).`,
        ...v.drifted.map((id) => `  DRIFTED  ${id}`),
        ...v.clean.map((id) => `  current  ${id}`),
      ].join("\n")}\n`,
    );
    process.exit(v.drifted.length > 0 ? 1 : 0);
  }
  if (filters.mine || filters.author) {
    const who = filters.author ?? resolveMine(process.env);
    if (!who) {
      process.stderr.write(
        "graph-promote-check: `--mine` cannot resolve who you are, so it is REFUSING rather than\n" +
          "  filtering to nothing. A write is stamped from `$BSC_UI_WRITER` (else the literal string\n" +
          "  `unknown`), so that variable is the only identity this can honestly match — and `unknown`\n" +
          "  is not one: most rows carry it. Set BSC_UI_WRITER, or name it: --author <who>.\n",
      );
      process.exit(2);
    }
    const sel = selectByAuthor(ids, (id) => history(usable.path, id), who, { deadlineMs: legDeadlineMs });
    process.stdout.write(
      `${[
        `graph: the repo store is out of date — ${ids.length} record(s) drifted in total.`,
        authorCoverage(sel, ids.length, who),
        ...sel.matched.map((id) => `  ${id}`),
      ].join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(driftHeadline(ids.length));
  const diagOpts = { limit: PROMOTE_CHECK_DETAIL_CAP, deadlineMs: legDeadlineMs };
  process.stdout.write(attribute(ids, (id) => history(usable.path, id), Date.now(), diagOpts));
  // Compute the committed-store commit list ONCE, not once per id. It was inside the per-id `blame`
  // closure, so a run with 344 drifted ids ran `git log` over the 2 MB store 344 times (request #253);
  // `lastRepoCommit` only READS this list, so one call feeds every id.
  const commits = commitsTouchingStore(ROOT);
  process.stdout.write(
    diagnose(
      ids,
      {
        runtime: (id) => impl(usable.path, id),
        repo: (id) => repoRecord(ROOT, id),
        // A record that HAS its own file needs no walk at all: the newest commit on that path is the
        // one that changed it. `lastRepoCommit` is the fallback for a record still inside the monolith,
        // where every commit touches the same file and only a diff can say which one changed this id.
        blame: (id) => {
          const own = commitsTouchingRecordFile(ROOT, id);
          if (own.length > 0) return { ...own[0], exhausted: false };
          return lastRepoCommit(id, commits, (sha) => recordAtCommit(ROOT, sha, id));
        },
      },
      diagOpts,
    ),
  );
  process.exit(1);
}
