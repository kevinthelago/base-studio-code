// The standing byte-determinism guard for the record emitter (epic
// `imports-are-derived-from-the-composes-graph`).
//
// WHY. The imports→composes migration re-derives every import from the `imports` field at emit time.
// If that derivation orders symbols or import lines by hashmap iteration (or anything else
// non-deterministic), two emits of the SAME seed produce DIFFERENT bytes — which compiles fine and
// passes tsc/vitest, but silently defeats the `emit-parity` migration proof (a moving target can never
// be shown byte-identical). This guard catches that class in seconds: emit the seed to two fresh
// scratch repos and assert the emitted trees are byte-for-byte equal.
//
// This is a per-commit gate leg (vitest runs in the gate). It emits to TWO throwaway dirs, never the
// shared `.bsc-records/`, so it cannot race the other suite legs that read that tree (see
// `emitOnce.test.ts` for why touching the shared tree mid-suite is destructive). The one-shot
// two-ref MIGRATION proof is the separate `scripts/emit-parity.mjs`.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitBinary } from "./emit-records.mjs";
import { snapshotDir, diffManifests } from "./emit-parity.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Copy just the seed into a scratch repo and emit its `.bsc-records/`. `bsc-emit` materializes from
 *  the packaged seed under `src-tauri/data`, so a seed-only copy is a complete, isolated input. */
function emitToScratch(bin: string): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "emit-det-"));
  try {
    cpSync(join(REPO, "src-tauri", "data"), join(dir, "src-tauri", "data"), { recursive: true });
    execFileSync(bin, ["--repo", dir, "--quiet"], { stdio: ["ignore", "ignore", "inherit"] });
    return snapshotDir(join(dir, ".bsc-records"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("record emit is byte-deterministic", () => {
  it("two fresh emits of the same seed produce byte-identical trees", () => {
    const bin = emitBinary();
    const a = emitToScratch(bin);
    const b = emitToScratch(bin);
    expect(a.size).toBeGreaterThan(0);
    const d = diffManifests(a, b);
    // If this fails, the emitter (likely the imports derivation) is ordering something
    // non-deterministically — fix the ordering; do NOT relax this guard, or `emit-parity` can never
    // prove the migration lossless.
    expect({ onlyBefore: d.onlyBefore, onlyAfter: d.onlyAfter, changed: d.changed }).toEqual({
      onlyBefore: [],
      onlyAfter: [],
      changed: [],
    });
  }, 120_000);
});

describe("diffManifests", () => {
  it("reports added, removed, and changed paths", () => {
    const before = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);
    const after = new Map([["a", "1"], ["b", "9"], ["d", "4"]]);
    expect(diffManifests(before, after)).toEqual({
      onlyBefore: ["c"],
      onlyAfter: ["d"],
      changed: ["b"],
    });
  });

  it("is empty for identical manifests", () => {
    const m = new Map([["x", "h1"], ["y", "h2"]]);
    expect(diffManifests(m, new Map(m))).toEqual({ onlyBefore: [], onlyAfter: [], changed: [] });
  });
});
