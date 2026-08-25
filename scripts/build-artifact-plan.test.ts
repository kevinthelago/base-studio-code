// Unit tests for the pure build-artifact verification logic
// (#a-corrupt-build-artifact-has-no-recovery-path). These cover the classification rules and the
// failure-signature matching without touching a filesystem or running a build.
import { describe, expect, it } from "vitest";
import {
  classifyArtifact,
  classifyBuildFailure,
  failingPackage,
  planVerification,
  MIN_PLAUSIBLE_BYTES,
} from "./build-artifact-plan.mjs";

const A = { name: "bsc", path: "/t/target/debug/bsc" };
/** A healthy stat: big, regular, owner-executable. */
const good = { size: 261_000_000, mode: 0o100755, isFile: true };

describe("classifyArtifact", () => {
  it("passes a real binary", () => {
    const v = classifyArtifact(A, good);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("");
  });

  // THE FAILURE THIS EXISTS FOR. Observed twice on 2026-08-24: a concurrent build left the file at
  // 0 bytes and cargo would not restore it, because its fingerprint said the unit was current.
  it("flags a 0-byte artifact as healable, naming a concurrent build", () => {
    const v = classifyArtifact(A, { ...good, size: 0 });
    expect(v.ok).toBe(false);
    expect(v.healable).toBe(true);
    expect(v.reason).toMatch(/0 bytes/);
    expect(v.reason).toMatch(/concurrent build/);
  });

  it("flags an implausibly small artifact", () => {
    expect(classifyArtifact(A, { ...good, size: MIN_PLAUSIBLE_BYTES - 1 }).ok).toBe(false);
    // The boundary is inclusive-ok, so a file exactly at the floor is not flagged.
    expect(classifyArtifact(A, { ...good, size: MIN_PLAUSIBLE_BYTES }).ok).toBe(true);
  });

  // The second half of the same incident: `fs.copyFile` carries the SOURCE's mode, so an artifact
  // caught mid-write lands 0644 and fails to exec — reported as "Permission denied", which reads as
  // a permissions problem and sends the reader somewhere else.
  it("flags a non-executable artifact and says how it will fail", () => {
    const v = classifyArtifact(A, { ...good, mode: 0o100644 });
    expect(v.ok).toBe(false);
    expect(v.healable).toBe(true);
    expect(v.reason).toMatch(/not executable/);
    expect(v.reason).toMatch(/Permission denied/);
  });

  // MISSING is NOT healable, and the distinction is load-bearing: healing means "remove it and
  // rebuild", and there is nothing to remove. A build that did not emit the binary will not emit it
  // on a retry either, so reporting it as a transient truncation would be a lie that costs a rebuild.
  it("treats a missing artifact as unhealable, not as a truncation", () => {
    const v = classifyArtifact(A, null);
    expect(v.ok).toBe(false);
    expect(v.healable).toBe(false);
    expect(v.reason).toMatch(/missing/);
  });

  it("treats a non-file as unhealable", () => {
    const v = classifyArtifact(A, { ...good, isFile: false });
    expect(v.ok).toBe(false);
    expect(v.healable).toBe(false);
  });
});

describe("planVerification", () => {
  it("partitions a set into bad and healable", () => {
    const set = [
      { name: "bsc", path: "/t/bsc" },
      { name: "bsc-agent", path: "/t/bsc-agent" },
      { name: "bsc-hook", path: "/t/bsc-hook" },
    ];
    const stats: Record<string, typeof good | null> = {
      "/t/bsc": { ...good, size: 0 }, // truncated  → healable
      "/t/bsc-agent": good, // fine
      "/t/bsc-hook": null, // missing    → bad, not healable
    };
    const { verdicts, bad, healable } = planVerification(set, (a) => stats[a.path]);
    expect(verdicts).toHaveLength(3);
    expect(bad.map((b) => b.name)).toEqual(["bsc", "bsc-hook"]);
    expect(healable.map((h) => h.name)).toEqual(["bsc"]);
  });

  it("an all-healthy set yields nothing to do", () => {
    const { bad, healable } = planVerification([{ name: "bsc", path: "/t/bsc" }], () => good);
    expect(bad).toEqual([]);
    expect(healable).toEqual([]);
  });
});

describe("classifyBuildFailure", () => {
  // Verbatim from the 2026-08-24 incident, where the app failed to link for ~40 minutes while
  // `cargo check` passed throughout.
  const REAL = `
error: linking with \`cc\` failed: exit status: 1
  = note: rust-lld: error: undefined hidden symbol: base_studio_code_lib::console::pty::env::sidecar_bin_path (.llvm.1589432337968318275)
          collect2: error: ld returned 1 exit status
error: could not compile \`base-studio-code\` (bin "base-studio-code") due to 1 previous error`;

  it("recognises the real link failure and names the package to clean", () => {
    const { matched, signature } = classifyBuildFailure(REAL);
    expect(matched).toBe(true);
    expect(signature).toMatch(/undefined hidden symbol/i);
    expect(failingPackage(REAL)).toBe("base-studio-code");
  });

  // The guard that keeps this useful: an ORDINARY compile error must NOT be classified as an
  // artifact problem, or the remedy printed would send someone to `cargo clean` for a typo.
  it("does not claim a genuine source error is an artifact problem", () => {
    const src = `error[E0425]: cannot find value \`foo\` in this scope
error: could not compile \`bsc-fleet\` (lib) due to 1 previous error`;
    expect(classifyBuildFailure(src).matched).toBe(false);
    // The package is still readable, so a caller can name it even when the class is different.
    expect(failingPackage(src)).toBe("bsc-fleet");
  });

  it("recognises the other stale-artifact shapes", () => {
    for (const s of [
      "error: found invalid metadata files for crate `foo`",
      "error[E0463]: can't find crate for `bsc_util`",
    ]) {
      expect(classifyBuildFailure(s).matched).toBe(true);
    }
  });

  it("is empty-safe", () => {
    expect(classifyBuildFailure("").matched).toBe(false);
    expect(classifyBuildFailure(undefined as unknown as string).matched).toBe(false);
    expect(failingPackage("")).toBe("");
  });
});
