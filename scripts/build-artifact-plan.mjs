// Pure decision logic for verifying build outputs (#a-corrupt-build-artifact-has-no-recovery-path).
//
// Split from the fs-touching runner (`verify-build-artifacts.mjs`) the same way
// `gate-lock-plan.mjs` is split from `gateLock.mjs`, so the rules can be tested
// against a table of stats instead of a filesystem. No imports; every function is pure.
//
// ## Why a build output needs checking at all
//
// Cargo does not notice a truncated artifact. MEASURED twice on 2026-08-24: `target/debug/bsc` was
// left at 0 bytes by a concurrent build, and the next `cargo build -p bsc --bin bsc` reported
// `Finished` in 0.40s WITHOUT restoring it — its fingerprint says the unit is current and it never
// re-checks that the artifact still exists as written. The file survives every subsequent build
// until something removes it or a source file is touched.
//
// That is why the heal is `rm` + rebuild rather than just rebuild: removing the artifact is the only
// thing that makes cargo's fingerprint disagree with reality in the direction we need.
//
// ## Why `mode` matters as much as `size`
//
// `fs.copyFile` carries the SOURCE's mode, so an artifact caught mid-write at 0644 lands
// unrunnable. That was the second half of the same incident — not merely empty, but `-rw-rw-r--`,
// so even a byte-correct binary at that path would have failed to exec. The symptom is
// `Permission denied`, which reads as a permissions problem and sends the reader somewhere else
// entirely.

/** A build output is expected to be at least this large. A real `bsc` is ~260 MB and the smallest
 *  sidecar (`bsc-hook`) ~6 MB, so anything under a few KB is a placeholder or a stub, never a
 *  linked binary. Deliberately NOT tuned close to the real sizes: this is a corruption tripwire,
 *  not a size assertion, and a tight bound would fire on a legitimately small future sidecar. */
export const MIN_PLAUSIBLE_BYTES = 4096;

/**
 * Classify one artifact from its stat. `stat` is `null` when the path does not exist.
 *
 * @param {{name: string, path: string}} artifact
 * @param {{size: number, mode: number, isFile: boolean} | null} stat
 * @returns {{name: string, path: string, ok: boolean, reason: string, healable: boolean}}
 */
export function classifyArtifact(artifact, stat) {
  const base = { name: artifact.name, path: artifact.path };
  if (stat === null) {
    // MISSING is not healable by removing it — there is nothing to remove, and a rebuild that did
    // not produce it will not produce it on a retry either. This means the build genuinely did not
    // emit the binary, which is a different failure from a corrupt one and must be reported as such.
    return { ...base, ok: false, reason: "missing — the build did not produce it", healable: false };
  }
  if (!stat.isFile) {
    return { ...base, ok: false, reason: "not a regular file", healable: false };
  }
  if (stat.size === 0) {
    return {
      ...base,
      ok: false,
      reason: "0 bytes — truncated, most likely by a concurrent build",
      healable: true,
    };
  }
  if (stat.size < MIN_PLAUSIBLE_BYTES) {
    return {
      ...base,
      ok: false,
      reason: `${stat.size} bytes — too small to be a linked binary`,
      healable: true,
    };
  }
  // Executable for the owner is the bit that matters; a build output is not group/world-critical.
  if ((stat.mode & 0o100) === 0) {
    return {
      ...base,
      ok: false,
      reason: `mode ${(stat.mode & 0o777).toString(8)} — not executable, so exec fails as "Permission denied"`,
      healable: true,
    };
  }
  return { ...base, ok: true, reason: "", healable: false };
}

/**
 * Classify a whole set. Returns every artifact's verdict plus the two partitions a caller acts on.
 *
 * @param {Array<{name: string, path: string}>} artifacts
 * @param {(a: {name: string, path: string}) => ({size: number, mode: number, isFile: boolean} | null)} statOf
 */
export function planVerification(artifacts, statOf) {
  const verdicts = artifacts.map((a) => classifyArtifact(a, statOf(a)));
  return {
    verdicts,
    bad: verdicts.filter((v) => !v.ok),
    healable: verdicts.filter((v) => !v.ok && v.healable),
  };
}

/** Signatures that mean "the artifact SET is inconsistent", as distinct from "the source is wrong".
 *
 *  Each was chosen because its remedy is mechanical (`cargo clean -p <pkg>`) and its cause is never
 *  the code. The first is the one observed on 2026-08-24, where the app failed to link for ~40
 *  minutes while `cargo check` passed the whole time:
 *
 *      rust-lld: error: undefined hidden symbol:
 *        base_studio_code_lib::console::pty::env::sidecar_bin_path (.llvm.1589432337968318275)
 *
 *  NOTE these are matched to DIAGNOSE, never to act. Auto-cleaning on a match would discard ~30 GB
 *  and could mask a genuine source error behind a 26s rebuild; this repo already refuses to wire
 *  destructive janitors into the gate (`worktrees:cap`), and this follows that line. */
export const ARTIFACT_INCONSISTENCY_SIGNATURES = [
  /undefined hidden symbol/i,
  /found invalid metadata files/i,
  /can't find crate for/i,
  /invalid or incompatible metadata/i,
  /rlib.*(?:corrupt|truncated)/i,
];

/**
 * Does this build output look like an inconsistent artifact set rather than a source error?
 * @param {string} stderr
 * @returns {{matched: boolean, signature: string}}
 */
export function classifyBuildFailure(stderr) {
  const text = String(stderr ?? "");
  for (const re of ARTIFACT_INCONSISTENCY_SIGNATURES) {
    const m = text.match(re);
    if (m) return { matched: true, signature: m[0] };
  }
  return { matched: false, signature: "" };
}

/** The package whose artifacts to clean, read out of cargo's own "could not compile `X`" line.
 *  Returned so the printed remedy names a package instead of telling the reader to guess. */
export function failingPackage(stderr) {
  const m = String(stderr ?? "").match(/could not compile `([^`]+)`/);
  return m ? m[1] : "";
}
