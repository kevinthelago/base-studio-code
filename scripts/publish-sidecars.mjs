// Publish the just-built sidecars to the stable dir a session resolves `$BSC_BIN` from — atomically.
//
//   node scripts/publish-sidecars.mjs [--profile debug|release] [--quiet]
//
// Runs at the end of `build:plan`, after `verify-build-artifacts.mjs` has established that the
// artifacts are real. Verification says the binary is good; this is what makes the good one reachable.
//
// ## Why publishing belongs at BUILD time
//
// `stage_dev_sidecars` (console/pty/env.rs) copies these into `~/.base-studio-code/bin` when the APP
// boots. That makes the stable copy current as of the last restart rather than as of the last build:
// measured on 2026-08-25, a `bsc` built at 07:43 was still not staged at 08:00, and the staged copy was
// seven hours old. A stale stable copy is what makes reaching for `target/debug/bsc` directly tempting,
// and running THAT path is the one remaining way to meet a truncated artifact
// (`the-installed-bsc-binary-silently-reverts-to-an-old-build` names it as the surviving gap).
//
// Boot staging is unchanged and still the safety net for a binary that arrived some other way.
//
// ## Why the temp file lives in the DESTINATION directory
//
// So the rename is same-filesystem and cannot fail with EXDEV. The rename is the whole point: it is
// atomic, so a reader sees the entire old file or the entire new one and never a fragment — unlike a
// copy straight onto the destination, which truncates first and leaves `$BSC_BIN` a growing fragment
// for as long as 261 MB takes to write.
//
// On POSIX, renaming over a binary that is currently being EXECUTED is legal — the running process
// keeps its inode. Only truncating in place gives ETXTBSY. On Windows the rename fails while the
// destination is open for execution; there the previous copy simply stands and boot staging (which has
// a park-and-replace fallback for exactly that) catches up on the next restart.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyArtifact } from "./build-artifact-plan.mjs";
import { expectedBins } from "./lib/sidecarBins.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_DIR = join(homedir(), ".base-studio-code", "bin");

/**
 * Should this artifact be published?
 *
 * Pure, so the policy is testable without a filesystem or a subprocess. Two independent reasons to
 * refuse, and they are not the same check:
 *
 *  - the artifact is not OK — `classifyArtifact`'s verdict, the SAME rule the verifier uses, so a
 *    binary this refuses is exactly one that failed verification rather than a second opinion;
 *  - `bsc` ran but did not identify itself — the handshake. A zero-byte binary passes size checks the
 *    moment it is a stub instead of empty, and through bash a non-binary file runs as a shell script.
 *    Publishing something that cannot answer for itself puts it where every session resolves $BSC_BIN.
 *
 * The handshake is asked of `bsc` only: it is the one with a `version` verb, and demanding one from
 * `bsc-hook` (a PreToolUse hook that reads stdin) would refuse a perfectly good binary.
 */
export function publishDecision(verdict, { handshakes }) {
  if (!verdict.ok) return { publish: false, reason: verdict.reason };
  if (verdict.name === "bsc" && !handshakes) {
    return { publish: false, reason: "ran but did not identify itself — an incoherent build" };
  }
  return { publish: true, reason: "" };
}

/** The temp path a publish writes through — in the DESTINATION's directory, and pid-tagged so two
 *  concurrent builds cannot collide on it. */
export function stagingPathFor(dst, pid) {
  const name = dst.split(/[\\/]/).pop();
  return join(dirname(dst), `.${name}.publishing-${pid}`);
}

function statOf(a) {
  try {
    const s = statSync(a.path);
    return { size: s.size, mode: s.mode, isFile: s.isFile() };
  } catch {
    return null;
  }
}

function handshakes(path) {
  try {
    const out = execFileSync(path, ["version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    return /^bsc\s/.test(String(out).trim());
  } catch {
    return false;
  }
}

function main(argv) {
  const at = argv.indexOf("--profile");
  const named = at === -1 ? undefined : argv[at + 1];
  const profile = argv.includes("--release") || named === "release" ? "release" : "debug";
  const quiet = argv.includes("--quiet");
  const exe = process.platform === "win32" ? ".exe" : "";

  mkdirSync(STAGED_DIR, { recursive: true });
  let published = 0;
  for (const name of expectedBins(REPO_ROOT)) {
    const artifact = { name, path: join(REPO_ROOT, "target", profile, `${name}${exe}`) };
    const verdict = classifyArtifact(artifact, statOf(artifact));
    // The handshake costs a subprocess, so it is only run when it can change the answer.
    const asked = verdict.ok && name === "bsc" ? handshakes(artifact.path) : true;
    const decision = publishDecision(verdict, { handshakes: asked });
    if (!decision.publish) {
      console.error(`[publish-sidecars] NOT publishing ${name}: ${decision.reason}. The previous staged copy stands.`);
      continue;
    }
    const dst = join(STAGED_DIR, `${name}${exe}`);
    const tmp = stagingPathFor(dst, process.pid);
    try {
      rmSync(tmp, { force: true });
      copyFileSync(artifact.path, tmp);
      // The mode is set BEFORE the rename, so the published path is never briefly unrunnable.
      if (process.platform !== "win32") chmodSync(tmp, 0o755);
      renameSync(tmp, dst);
      published += 1;
    } catch (e) {
      rmSync(tmp, { force: true });
      console.error(`[publish-sidecars] could not publish ${name} (${e.message}); the previous staged copy stands`);
    }
  }
  if (!quiet && published > 0) console.log(`[publish-sidecars] ${published} → ${STAGED_DIR}`);
  return 0;
}

// NEVER fails the build. A publish that could redden `build:plan` would be a janitor people delete;
// the worst case here is that the staged copy stays exactly what it already was — today's behaviour.
if (process.argv[1]?.endsWith("publish-sidecars.mjs")) process.exit(main(process.argv.slice(2)));
