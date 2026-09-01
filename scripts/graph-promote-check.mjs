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
import { statSync } from "node:fs";
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
    process.stdout.write(attribute(drifted(String(err.stdout ?? "")), (id) => history(usable.path, id), Date.now()));
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
