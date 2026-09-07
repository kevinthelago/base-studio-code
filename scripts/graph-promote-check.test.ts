import { describe, expect, it } from "vitest";
import {
  ago,
  attribute,
  diagnose,
  drifted,
  lastRepoCommit,
  PROMOTE_CHECK_DEFAULT_TIMEOUT_MS,
  promoteCheckTimeoutMs,
  promoteCheckTimeoutVerdict,
  shapeOf,
} from "./graph-promote-check.mjs";

const NOW = Date.parse("2026-09-01T15:21:58Z");

describe("graph-promote-check attribution", () => {
  it("pulls the drifted ids out of the checker's JSON line", () => {
    // The real stdout: a human message, the JSON, then the message again.
    const out = [
      "bsc: the repo store is out of date — 1 drifted (session-roles.ts).",
      '{"checked":69,"drifted":["session-roles.ts"],"runtimeBehind":[],"ok":false}',
      "bsc: the repo store is out of date — 1 drifted (session-roles.ts).",
    ].join("\n");
    expect(drifted(out)).toEqual(["session-roles.ts"]);
  });

  it("is quiet rather than throwing when there is no JSON to read", () => {
    expect(drifted("graph: no usable `bsc` binary")).toEqual([]);
    expect(drifted("{not json at all")).toEqual([]);
    expect(drifted("")).toEqual([]);
  });

  /**
   * THE CASE THIS EXISTS FOR. A gate went red 31 seconds after another session authored the record —
   * the check reads a SHARED runtime store, so a red is often live authoring rather than stale drift.
   * Following the bare "run `bsc graph promote`" advice there commits someone's half-written record.
   */
  it("warns off a promote when the drift is seconds old", () => {
    const h = { rev: 4, updatedBy: "", updatedAt: "2026-09-01T15:21:27Z" };
    const out = attribute(["session-roles.ts"], () => h, NOW);
    expect(out).toContain("31s ago");
    expect(out).toContain("ANOTHER SESSION IS PROBABLY MID-EDIT");
    expect(out).toContain("Do NOT `bsc graph promote`");
    expect(out).toContain("unknown"); // an unattributed write is itself the finding
  });

  it("does not cry mid-edit over drift that is genuinely stale", () => {
    const h = { rev: 2, updatedBy: "claude", updatedAt: "2026-08-30T09:00:00Z" };
    const out = attribute(["old-node.ts"], () => h, NOW);
    expect(out).toContain("by claude");
    expect(out).not.toContain("MID-EDIT");
  });

  /** `fleet-director-bridge.ts` was exactly this: rev 0, no author, no timestamp, unowned for weeks. */
  it("reports a never-stamped record as never stamped rather than inventing an age", () => {
    const out = attribute(["fleet-director-bridge.ts"], () => ({ rev: 0, updatedBy: "", updatedAt: "" }), NOW);
    expect(out).toContain("never stamped");
    expect(out).not.toContain("MID-EDIT");
  });

  it("says so when a node's history cannot be read, instead of dropping it", () => {
    expect(attribute(["x.ts"], () => null, NOW)).toContain("no history available");
  });

  it("emits nothing at all when nothing drifted", () => {
    expect(attribute([], () => null, NOW)).toBe("");
  });

  it("scales the age and refuses to guess at an unparseable stamp", () => {
    expect(ago("2026-09-01T15:21:27Z", NOW)).toBe("31s ago");
    expect(ago("2026-09-01T14:21:58Z", NOW)).toBe("60m ago");
    expect(ago("2026-08-30T15:21:58Z", NOW)).toBe("2d ago");
    expect(ago("", NOW)).toBeNull();
    expect(ago(undefined, NOW)).toBeNull();
  });
});

/**
 * The wall-clock bound that keeps this leg from spinning forever and starving the shared gate slot
 * (request #253). The env parsing and the verdict wording are pure; the CLI-spawn test at the bottom
 * proves the bound actually FIRES and the process exits fast and non-zero.
 */
describe("graph-promote-check wall-clock bound", () => {
  it("defaults well above a healthy ~37s run and honours the env override", () => {
    expect(promoteCheckTimeoutMs({})).toBe(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS);
    expect(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "500" })).toBe(500);
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "240000" })).toBe(240_000);
  });

  /** Junk must fall back to the default, NEVER disable the bound — a check with no bound is the bug. */
  it("falls back to the default rather than disabling the bound on junk or non-positive input", () => {
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "" })).toBe(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS);
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "nope" })).toBe(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS);
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "-5" })).toBe(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS);
    expect(promoteCheckTimeoutMs({ BSC_PROMOTE_CHECK_TIMEOUT_MS: "0" })).toBe(PROMOTE_CHECK_DEFAULT_TIMEOUT_MS);
  });

  /** A timeout is a check that could not check — it must read as NOT verified, never as clean/passed. */
  it("its verdict says NOT verified and never claims the store is current", () => {
    const v = promoteCheckTimeoutVerdict(180_000, "SIGKILL", { code: "ETIMEDOUT" });
    expect(v).toContain("TIMED OUT");
    expect(v).toContain("NOT verified");
    expect(v).toContain("180s wall-clock bound");
    expect(v).toContain("could NOT hold the full-gate slot");
    expect(v).not.toMatch(/repo store is current|is clean|passed/);
  });

  it("names a non-timeout termination as terminated rather than as a timeout", () => {
    const v = promoteCheckTimeoutVerdict(180_000, "SIGSEGV", { code: "SIGSEGV" });
    expect(v).toContain("was terminated");
    expect(v).not.toContain("wall-clock bound");
  });
});

/**
 * The DIAGNOSTIC loop is the dominant cost of a red run: each id shells out (attribute → `bsc impl
 * history`; diagnose → `bsc impl get` + a git-history walk of the 2 MB store). MEASURED 344 drifted ids
 * at once under heavy concurrent authoring — thousands of subprocesses, the real 32-minute spin. These
 * pin that the loop stops at a count cap or a wall-clock deadline and SAYS it truncated. Neither param
 * existed before request #253, so calling with them against the old code produced no truncation line.
 */
describe("graph-promote-check diagnostic bound", () => {
  const manyIds = Array.from({ length: 100 }, (_, i) => `node-${i}.ts`);
  const h = { rev: 1, updatedBy: "someone", updatedAt: "2026-08-30T09:00:00Z" };

  it("attribute stops at the detail cap and names how many of how many it covered", () => {
    let calls = 0;
    const out = attribute(manyIds, () => { calls += 1; return h; }, NOW, { limit: 3 });
    expect(calls).toBe(3); // it did NOT shell out for the other 97
    expect(out).toContain("stopped after 3 of 100 (detail cap)");
    expect(out).toContain("named in the check output above");
  });

  it("attribute stops on a blown wall-clock deadline", () => {
    const out = attribute(manyIds, () => h, NOW, { deadlineMs: Date.now() - 1 });
    expect(out).toContain("(time budget)");
    expect(out).toContain("stopped after 0 of 100");
  });

  it("diagnose stops at the detail cap without running the expensive per-id io for the rest", () => {
    let blames = 0;
    const io = {
      runtime: () => ({ id: "x", code: "y".repeat(3000) }),
      repo: () => COMMITTED,
      blame: () => { blames += 1; return null; },
    };
    const out = diagnose(manyIds, io, { limit: 2 });
    expect(blames).toBe(2);
    expect(out).toContain("stopped after 2 of 100 (detail cap)");
  });

  it("is unchanged when no bound is given — the full list is detailed", () => {
    let calls = 0;
    const out = attribute(["a.ts", "b.ts"], () => { calls += 1; return h; }, NOW);
    expect(calls).toBe(2);
    expect(out).not.toContain("stopped after");
  });
});

/**
 * The two records as they ACTUALLY stood on 2026-09-01, when `graph-promote-check` had been red all
 * day on a rotating node and every `npm run promote` was forced through `--skip-gate`.
 *
 * The runtime copy is not a stale edit. Every value in it is the fixture of
 * `tests_set_upserts_by_name_and_does_not_drop_sibling_tests` in `crates/bsc-graph/src/cli.rs`, which
 * wrote into the real per-user store through an unlocked process-global `BSC_GRAPH_STORE`. Promoting
 * this id — the one thing the bare failure message advises — would have written 33 characters over a
 * 3263-character record permanently.
 */
const POISONED_RUNTIME = {
  id: "session-roles.ts",
  name: "session-roles",
  code: "export function sessionRoles() {}",
  tech: "typescript",
  rev: 4,
  updatedBy: "unknown",
  updatedAt: "2026-09-01T15:21:27Z",
};
const COMMITTED = {
  id: "session-roles.ts",
  name: "sessionRoles",
  code: "x".repeat(3263),
  tech: "typescript",
};

describe("graph-promote-check drift shape", () => {
  it("names WHICH FIELDS differ, so an id is not the whole answer", () => {
    const shape = shapeOf(POISONED_RUNTIME, COMMITTED);
    expect(shape?.fields).toEqual(["code", "name"]);
    expect(shape?.runtimeCode).toBe(33);
    expect(shape?.repoCode).toBe(3263);
  });

  it("flags the collapse that says a TEST wrote this, not an author", () => {
    expect(shapeOf(POISONED_RUNTIME, COMMITTED)?.collapsed).toBe(true);
  });

  /** A ratio on a tiny body means nothing — a two-line helper halving is ordinary. */
  it("does not cry collapse over a small record", () => {
    const repo = { id: "x.ts", code: "export const a = 1;\n".repeat(4) };
    const runtime = { id: "x.ts", code: "export const a = 1;\n" };
    expect(shapeOf(runtime, repo)?.collapsed).toBe(false);
  });

  it("does not cry collapse over an ordinary edit to a large record", () => {
    const runtime = { id: "x.ts", code: "y".repeat(3000) };
    expect(shapeOf(runtime, COMMITTED)?.collapsed).toBe(false);
    expect(shapeOf(runtime, COMMITTED)?.fields).toEqual(["code", "id", "name", "tech"]);
  });

  it("ignores the server-managed stamps, which move on every write", () => {
    const a = { id: "x.ts", code: "same", rev: 9, updatedAt: "then", updatedBy: "me", history: [1], build: {} };
    const b = { id: "x.ts", code: "same", rev: 1, updatedAt: "now", updatedBy: "you", history: [], build: null };
    expect(shapeOf(a, b)?.fields).toEqual([]);
  });

  it("has no opinion when a copy cannot be read", () => {
    expect(shapeOf(null, COMMITTED)).toBeNull();
    expect(shapeOf(POISONED_RUNTIME, null)).toBeNull();
  });
});

describe("graph-promote-check repo-side attribution", () => {
  const commits = [
    { sha: "ccc", author: "c", date: "2026-09-01", subject: "touched the file, not this record" },
    { sha: "bbb", author: "b", date: "2026-08-30", subject: "changed the record" },
    { sha: "aaa", author: "a", date: "2026-08-28", subject: "first" },
  ];

  /** The commit that CHANGED it, not the newest that merely touched the 2.3 MB file around it. */
  it("names the commit whose value differs from its predecessor's", () => {
    const at = (sha: string) => (sha === "aaa" ? { id: "x", code: "old" } : { id: "x", code: "new" });
    expect(lastRepoCommit("x", commits, at)?.sha).toBe("bbb");
  });

  it("names the newest commit when it is the one that changed the record", () => {
    const at = (sha: string) => ({ id: "x", code: sha === "ccc" ? "newest" : "older" });
    expect(lastRepoCommit("x", commits, at)?.sha).toBe("ccc");
  });

  /** A record present in the oldest commit examined was introduced at or before it — say so. */
  it("reports an exhausted window rather than claiming nothing changed the record", () => {
    const at = () => ({ id: "x", code: "same throughout" });
    const found = lastRepoCommit("x", commits, at, 2);
    expect(found?.sha).toBe("bbb");
    expect(found?.exhausted).toBe(true);
  });

  it("returns null when the record never appears and there is nothing to attribute", () => {
    expect(lastRepoCommit("x", commits, () => null)).toBeNull();
    expect(lastRepoCommit("x", [], () => ({ id: "x" }))).toBeNull();
  });
});

describe("graph-promote-check diagnosis", () => {
  const io = {
    runtime: () => POISONED_RUNTIME,
    repo: () => COMMITTED,
    blame: () => ({ sha: "bd928e01", author: "princess-bubblegum", date: "2026-08-29", subject: "merge: the measurement surfaces" }),
  };

  /**
   * THE WHOLE POINT OF THIS SLICE. The old output named an id and advised `bsc graph promote`. Reading
   * it took forty minutes to establish that following that advice would destroy the record; this must
   * say so in one screen.
   */
  it("turns a bare id into a cause, an owner and a refusal", () => {
    const out = diagnose(["session-roles.ts"], io);
    expect(out).toContain("session-roles.ts");
    expect(out).toContain("bd928e01");
    expect(out).toContain("princess-bubblegum");
    expect(out).toContain("code 3263 -> 33 chars");
    expect(out).toContain("name");
    expect(out).toContain("the shape of a TEST that");
    expect(out).toContain("DO NOT `bsc graph promote`");
  });

  it("does not warn off a promote for ordinary drift", () => {
    const out = diagnose(["x.ts"], {
      runtime: () => ({ id: "x.ts", code: "y".repeat(3000) }),
      repo: () => COMMITTED,
      blame: () => null,
    });
    expect(out).toContain("no commit in the examined window changed this record");
    expect(out).not.toContain("DO NOT");
  });

  it("says the shape is unknown rather than dropping a node it cannot read", () => {
    const out = diagnose(["x.ts"], { runtime: () => null, repo: () => COMMITTED, blame: () => null });
    expect(out).toContain("could not be read");
  });

  it("emits nothing at all when nothing drifted", () => {
    expect(diagnose([], io)).toBe("");
  });
});

// ── the CLI path, which no in-process test can reach ─────────────────────────────────────────────
//
// Every test above imports `diagnose`/`shapeOf` and calls them AFTER the module has finished
// evaluating. The CLI does not: its entry block runs DURING evaluation, and for a while that block
// sat above `const STAMPS`, so every real drift died with
// `ReferenceError: Cannot access 'STAMPS' before initialization` — with six green tests over the
// very functions that were crashing.
//
// So this spawns the module as a PROCESS against a stub `bsc`. It is the only shape that can
// observe the declaration order the CLI actually uses.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A checkout-shaped temp dir: the module, its one lib import, a stub `bsc`, and a repo store. */
function stubCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "promote-check-cli-"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(join(root, "target", "debug"), { recursive: true });
  mkdirSync(join(root, "graph"), { recursive: true });
  copyFileSync(join(HERE, "graph-promote-check.mjs"), join(root, "scripts", "graph-promote-check.mjs"));
  copyFileSync(join(HERE, "lib", "bscBinary.mjs"), join(root, "scripts", "lib", "bscBinary.mjs"));

  // BOTH copies must be READABLE or `shapeOf` returns null before it ever touches `STAMPS` — the
  // early return would make this test pass against the unfixed module, which is the whole trap.
  const bsc = join(root, "target", "debug", "bsc");
  writeFileSync(
    bsc,
    [
      "#!/bin/sh",
      // `inspect` demands a handshake matching /^bsc\s/ before it will trust the binary.
      'if [ "$1" = "version" ]; then echo "bsc 0.0.0-stub"; exit 0; fi',
      'if [ "$1" = "graph" ] && [ "$2" = "impl" ] && [ "$3" = "get" ]; then',
      '  echo \'{"id":"stub.rs","code":"RUNTIME","tech":"rust"}\'; exit 0; fi',
      'if [ "$1" = "graph" ] && [ "$2" = "impl" ] && [ "$3" = "history" ]; then echo "[]"; exit 0; fi',
      // The drift itself: non-zero, with the JSON line `drifted()` parses.
      'echo \'{"checked":1,"drifted":["stub.rs"],"ok":false}\'',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(bsc, 0o755);

  // Same id, DIFFERENT code — so both copies parse and the shape comparison actually runs.
  writeFileSync(
    join(root, "graph", "algorithms.json"),
    JSON.stringify({ implementations: [{ id: "stub.rs", code: "REPO-IS-DIFFERENT", tech: "rust" }] }),
  );
  return root;
}

/** Run the copied module as a CLI. It exits 1 on drift by design, so the STATUS is not the signal. */
function runCli(root: string): string {
  try {
    return execFileSync(process.execPath, [join(root, "scripts", "graph-promote-check.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("graph-promote-check as a CLI", () => {
  it("completes its diagnosis instead of dying in the temporal dead zone", () => {
    const out = runCli(stubCheckout());
    // The regression, named exactly. Asserting on the message rather than on exit status matters:
    // the CLI exits 1 for a real drift too, so status alone cannot tell a crash from a finding.
    expect(out).not.toContain("ReferenceError");
    expect(out).not.toContain("before initialization");
  });

  it("still reaches the drift SHAPE, which is the half that was being lost", () => {
    const out = runCli(stubCheckout());
    // `attribute` always survived; `shapeOf` is what died. Assert on the half that was broken, or
    // this passes on a module that prints the attribution and then crashes.
    expect(out).toContain("what drifted");
    expect(out).toContain("stub.rs");
    // Both copies were readable and differ, so it must report the differing field rather than
    // "one of the two copies could not be read".
    expect(out).toContain("code");
  });
});

// ── the WALL-CLOCK BOUND, proven end to end ──────────────────────────────────────────────────────
//
// The bug (request #253) was that `bsc graph promote --check` could spin for 32+ minutes while
// `gate.mjs` held the single full-gate slot. No in-process test can prove the fix, because the bound
// is enforced around a spawned `bsc` and the value that matters is that the leg's PROCESS terminates
// fast and non-zero. So this points the CLI at a stub `bsc` whose `--check` SLEEPS far past the bound,
// sets a tiny BSC_PROMOTE_CHECK_TIMEOUT_MS, and asserts it aborts quickly with the loud verdict.

/** A checkout whose stub `bsc` hangs on `graph promote --check` (but answers the version handshake). */
function stubSlowCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "promote-check-slow-"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(join(root, "target", "debug"), { recursive: true });
  mkdirSync(join(root, "graph"), { recursive: true });
  copyFileSync(join(HERE, "graph-promote-check.mjs"), join(root, "scripts", "graph-promote-check.mjs"));
  copyFileSync(join(HERE, "lib", "bscBinary.mjs"), join(root, "scripts", "lib", "bscBinary.mjs"));

  const bsc = join(root, "target", "debug", "bsc");
  writeFileSync(
    bsc,
    [
      "#!/bin/sh",
      // The handshake must be instant so `pickUsable` trusts the binary...
      'if [ "$1" = "version" ]; then echo "bsc 0.0.0-slow"; exit 0; fi',
      // ...but the check itself hangs far past any test-sane bound. This stands in for the 32-minute
      // CPU spin measured against the real shared store.
      'if [ "$1" = "graph" ] && [ "$2" = "promote" ]; then sleep 60; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bsc, 0o755);
  writeFileSync(join(root, "graph", "algorithms.json"), JSON.stringify({ implementations: [] }));
  return root;
}

/** Run the copied module as a CLI, capturing STATUS and combined output. */
function runCliCapture(root: string, env: Record<string, string>): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(root, "scripts", "graph-promote-check.mjs")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("graph-promote-check wall-clock bound (CLI)", () => {
  it(
    "aborts a hung check fast, loudly, and non-zero instead of holding the slot",
    () => {
      const started = Date.now();
      const { status, out } = runCliCapture(stubSlowCheckout(), { BSC_PROMOTE_CHECK_TIMEOUT_MS: "800" });
      const elapsed = Date.now() - started;

      // FAST: it returned far under the 60s the stub would otherwise sleep — this is what frees the
      // gate slot rather than starving the fleet. Generous ceiling for a loaded CI box.
      expect(elapsed).toBeLessThan(20_000);
      // LOUD, and unmistakably NOT a pass.
      expect(out).toContain("TIMED OUT");
      expect(out).toContain("NOT verified");
      expect(out).not.toContain("repo store is current");
      // NON-ZERO: a check that could not check must redden the gate, never read green.
      expect(status).not.toBe(0);
    },
    30_000,
  );

  it(
    "does NOT abort a healthy fast check — the bound only bites a hang",
    () => {
      // The ordinary stub answers `--check` instantly (drift, exit 1). With a real bound it must reach
      // its normal verdict, proving the timeout is not amputating the good path.
      const { out } = runCliCapture(stubCheckout(), { BSC_PROMOTE_CHECK_TIMEOUT_MS: "180000" });
      expect(out).not.toContain("TIMED OUT");
      expect(out).toContain("what drifted");
    },
    30_000,
  );
});
