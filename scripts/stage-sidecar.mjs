// Stage the bsc-plan sidecar for Tauri's `bundle.externalBin` (#1089).
//
// Tauri's externalBin requires the binary on disk to be named with the target
// triple (`binaries/bsc-plan-<triple>[.exe]`); at bundle time the bundler strips
// the triple and copies it next to the app exe — exactly where `bsc_plan_bin_path()`
// (current_exe().with_file_name("bsc-plan.exe")) looks at runtime.
//
// Run from `beforeBuildCommand`, so it fires for both a local `tauri build` and
// every release-workflow leg, keyed off `TAURI_ENV_TARGET_TRIPLE` (set by the Tauri
// CLI per target). The macOS release builds `universal-apple-darwin`, whose sidecar
// must itself be a universal binary — so we build both Apple arches and `lipo` them.
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

/** The host target triple, used when TAURI_ENV_TARGET_TRIPLE isn't set (a bare
 *  `npm run stage:sidecar` outside the Tauri build). */
function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error("could not determine host triple from `rustc -vV`");
  return m[1].trim();
}

/** Build bsc-plan for one real rust target; return the path to the produced binary. */
function buildOne(triple) {
  run(`cargo build --release --target ${triple} --bin bsc-plan`);
  const ext = triple.includes("windows") ? ".exe" : "";
  return join("target", triple, "release", `bsc-plan${ext}`);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

if (triple === "universal-apple-darwin") {
  // No real rustc target named "universal" — build both slices and fuse with lipo.
  const arm = buildOne("aarch64-apple-darwin");
  const intel = buildOne("x86_64-apple-darwin");
  // Stage the per-arch reals too: Tauri's externalBin check may validate the per-arch
  // name during each slice's compile (not just the lipo'd universal one), so a real
  // binary must exist under every name the universal build might look for (#1091).
  copyFileSync(arm, join(outDir, "bsc-plan-aarch64-apple-darwin"));
  copyFileSync(intel, join(outDir, "bsc-plan-x86_64-apple-darwin"));
  const dst = join(outDir, "bsc-plan-universal-apple-darwin");
  run(`lipo -create -output ${dst} ${arm} ${intel}`);
  console.log(`staged universal sidecar (+ per-arch) -> ${dst}`);
} else {
  const ext = triple.includes("windows") ? ".exe" : "";
  const src = buildOne(triple);
  const dst = join(outDir, `bsc-plan-${triple}${ext}`);
  copyFileSync(src, dst);
  console.log(`staged sidecar -> ${dst}`);
}
