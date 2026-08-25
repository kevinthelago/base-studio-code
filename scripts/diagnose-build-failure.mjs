// Name a build failure that is an ARTIFACT problem rather than a source problem
// (#a-corrupt-build-artifact-has-no-recovery-path).
//
//   npm run diagnose:build -- <logfile>      # or pipe a log on stdin
//
// ## Why this exists as a separate reader
//
// On 2026-08-24 the app failed to link for ~40 minutes:
//
//     rust-lld: error: undefined hidden symbol:
//       base_studio_code_lib::console::pty::env::sidecar_bin_path (.llvm.1589432337968318275)
//
// `cargo check` passed the entire time — the source was never wrong. But the error only ever reached
// `tauri dev`'s tty, and from outside the symptom was "the dev server is up and the app never
// appears", which sends the reader to the wrong place entirely. Naming the class is most of the fix.
//
// ## Why it does not clean
//
// The remedy is `cargo clean -p <pkg>`, which discards ~30 GB and takes a full crate rebuild. Firing
// that automatically on a pattern match could mask a genuine source error behind a 26s rebuild, and
// this repo already refuses to wire destructive janitors into the gate (`worktrees:cap` is
// explicitly invoked by hand for the same reason). So: diagnose, print the command, stop.
import { readFileSync } from "node:fs";
import { classifyBuildFailure, failingPackage } from "./build-artifact-plan.mjs";

function readInput() {
  const file = process.argv[2];
  if (file) return readFileSync(file, "utf8");
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const text = readInput();
if (!text.trim()) {
  console.error("usage: node scripts/diagnose-build-failure.mjs <logfile>   (or pipe a log on stdin)");
  process.exit(2);
}

const { matched, signature } = classifyBuildFailure(text);
if (!matched) {
  console.log("no artifact-inconsistency signature found — treat this as a real build error.");
  process.exit(0);
}

const pkg = failingPackage(text) || "<package>";
console.log(
  `ARTIFACT INCONSISTENCY, not a source error.\n` +
    `  signature: ${signature}\n` +
    `  This means the compiled artifact set disagrees with itself — typically after a build was\n` +
    `  interrupted, or a second cargo ran against the same target/ directory. The source can be\n` +
    `  perfectly fine, and \`cargo check\` will usually pass while the link keeps failing.\n\n` +
    `  Fix:\n` +
    `      cargo clean -p ${pkg} && cargo build -p ${pkg}\n\n` +
    `  Then keep a second builder out of this tree — if a dev server is live here, gate in a\n` +
    `  worktree instead.`
);
