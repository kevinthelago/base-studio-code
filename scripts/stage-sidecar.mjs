// Stage the bsc-plan + bsc-agent sidecars for Tauri's `bundle.externalBin` (#1089/#1117).
//
// Tauri's externalBin requires each binary on disk to be named with the target triple
// (`binaries/<name>-<triple>[.exe]`); at bundle time the bundler strips the triple and
// copies it next to the app exe — exactly where the runtime resolver looks
// (current_exe().with_file_name("<name>[.exe]")).
//
// Run from `beforeBuildCommand`, so it fires for both a local `tauri build` and every
// release-workflow leg, keyed off `TAURI_ENV_TARGET_TRIPLE` (set by the Tauri CLI per
// target). The macOS release builds `universal-apple-darwin`, whose sidecars must each be
// a universal binary — so we build both Apple arches and `lipo` them.
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** The sidecar binaries shipped beside the app. */
const BINS = [
  "bsc-plan",
  "bsc-agent",
  "bsc-research-mcp",
  "bsc-compliance-mcp",
  "bsc-skill",
  "bsc-data",
  "bsc-logs",
  "bsc-compliance",
  "bsc-blueprint",
  "bsc-project",
];

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

/** The host target triple, used when TAURI_ENV_TARGET_TRIPLE isn't set (a bare
 *  `npm run stage:sidecar` outside the Tauri build). */
function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error("could not determine host triple from `rustc -vV`");
  return m[1].trim();
}

/** Build one bin for one real rust target; return the path to the produced binary. */
function buildOne(name, triple) {
  run(`cargo build --release --target ${triple} --bin ${name}`);
  const ext = triple.includes("windows") ? ".exe" : "";
  return join("target", triple, "release", `${name}${ext}`);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

for (const name of BINS) {
  if (triple === "universal-apple-darwin") {
    // No real rustc target named "universal" — build both slices and fuse with lipo.
    const arm = buildOne(name, "aarch64-apple-darwin");
    const intel = buildOne(name, "x86_64-apple-darwin");
    // Stage the per-arch reals too: Tauri's externalBin check may validate the per-arch
    // name during each slice's compile (not just the lipo'd universal one), so a real
    // binary must exist under every name the universal build might look for (#1091).
    copyFileSync(arm, join(outDir, `${name}-aarch64-apple-darwin`));
    copyFileSync(intel, join(outDir, `${name}-x86_64-apple-darwin`));
    const dst = join(outDir, `${name}-universal-apple-darwin`);
    run(`lipo -create -output ${dst} ${arm} ${intel}`);
    console.log(`staged universal sidecar (+ per-arch) -> ${dst}`);
  } else {
    const ext = triple.includes("windows") ? ".exe" : "";
    const src = buildOne(name, triple);
    const dst = join(outDir, `${name}-${triple}${ext}`);
    copyFileSync(src, dst);
    console.log(`staged sidecar -> ${dst}`);
  }
}
