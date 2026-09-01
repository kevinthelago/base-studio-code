#!/usr/bin/env node
/**
 * `node scripts/graph-promote-check.mjs` — the gate's half of the repo-store seam.
 *
 * Under files-to-zero the build compiles from `graph/algorithms.json`, a COMMITTED file, while authoring
 * happens in the per-user runtime store. `bsc graph promote` moves records across, and that seam has a
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
 *    committed ones are stale. `bsc graph promote --check` already returns `checked: 0` there; this
 *    wrapper just does not invent a failure around it.
 *
 * What DOES fail: a record that exists in both stores and differs. That is an edit which never reached
 * the compiler, and the underlying verb names the ids.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

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
  try {
    const out = execFileSync(usable.path, ["graph", "promote", "--check", "--root", ROOT], { encoding: "utf8" });
    process.stdout.write(out.trim() ? `${out.trim()}\n` : "graph: repo store is current\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(String(err.stdout ?? ""));
    process.stderr.write(String(err.stderr ?? ""));
    const ids = drifted(String(err.stdout ?? ""));
    process.stdout.write(attribute(ids, (id) => history(usable.path, id), Date.now()));
    process.stdout.write(
      diagnose(ids, {
        runtime: (id) => impl(usable.path, id),
        repo: (id) => repoRecord(ROOT, id),
        blame: (id) => lastRepoCommit(id, commitsTouchingStore(ROOT), (sha) => recordAtCommit(ROOT, sha, id)),
      }),
    );
    process.exit(1);
  }
}

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
 * The bare failure says only "the repo store is out of date — run `bsc graph promote`", and following
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
export function attribute(ids, historyFor, nowMs) {
  if (ids.length === 0) return "";
  const lines = ["", "who last authored each drifted node (from the RUNTIME store, which is shared):"];
  let fresh = false;
  for (const id of ids) {
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
      "  Do NOT `bsc graph promote` it — that commits their in-flight record to the build's source of truth.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One record's runtime provenance, or null when it cannot be read (never fatal — this is a diagnostic). */
function history(bsc, id) {
  try {
    return JSON.parse(execFileSync(bsc, ["graph", "impl", "history", id], { encoding: "utf8", timeout: 10_000 }));
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

/** The repo-side attribution + drift shape for each drifted id, as printable lines. */
export function diagnose(ids, io) {
  if (ids.length === 0) return "";
  const lines = ["", "what drifted, and who last authored it in the COMMITTED store:"];
  let collapsed = false;
  for (const id of ids) {
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
      "  DO NOT `bsc graph promote` a collapsed node — that writes the stub over the record permanently.",
      "  Restore the runtime copy from the committed one instead, then re-run this check.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One record out of the RUNTIME store, or null (never fatal — this is a diagnostic). */
function impl(bsc, id) {
  try {
    return JSON.parse(execFileSync(bsc, ["graph", "impl", "get", id], { encoding: "utf8", timeout: 10_000 }));
  } catch {
    return null;
  }
}

/** One record out of the COMMITTED store on disk. */
function repoRecord(root, id) {
  try {
    return pick(JSON.parse(readFileSync(join(root, "graph", "algorithms.json"), "utf8")), id);
  } catch {
    return null;
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

/** One record as it stood at `sha`, or null when the file did not exist / could not be parsed. */
function recordAtCommit(root, sha, id) {
  try {
    const text = execFileSync("git", ["show", `${sha}:graph/algorithms.json`], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return pick(JSON.parse(text), id);
  } catch {
    return null;
  }
}

/** The `id` record out of a parsed store document. */
function pick(doc, id) {
  const all = Array.isArray(doc?.implementations) ? doc.implementations : [];
  return all.find((r) => r?.id === id) ?? null;
}
