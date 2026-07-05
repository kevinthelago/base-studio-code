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
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The sidecar binaries shipped beside the app, derived from `tauri.conf.json`'s
 *  `bundle.externalBin` (the canonical list) with the `binaries/` prefix stripped — so adding a
 *  sidecar only means editing `externalBin`, never this file too (#1763). */
function sidecarBins() {
  const here = dirname(fileURLToPath(import.meta.url));
  const confPath = join(here, "..", "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const ext = conf?.bundle?.externalBin;
  if (!Array.isArray(ext) || ext.length === 0) {
    throw new Error(`no bundle.externalBin array in ${confPath}`);
  }
  return ext.map((p) => p.replace(/^binaries\//, ""));
}

const BINS = sidecarBins();

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

// ── Bundled host toolchain: gh + (Windows) PortableGit (#1277) ───────────────
//
// The mechanism the release build uses to ship `gh` (+ a POSIX/git runtime on Windows) so a clean
// machine works without a hand-installed toolchain. See `src-tauri/licenses/README.md` for the
// license/NOTICE obligations these bundled tools carry.
//
// OPT-IN + best-effort by design (HARD CONSTRAINT): this whole block is skipped unless
// `BSC_STAGE_TOOLCHAIN=1`, and every step is wrapped so a network/verify failure only WARNS and
// continues — it must never break the existing sidecar staging above or the `tauri build` it runs
// under. `gh` is NOT in `tauri.conf.json`'s `externalBin` yet (adding it there without a staged
// binary fails the build), so this stages the files but the live `externalBin`/resources wiring is
// the documented release-time step (see the PR / issue #1277).
//
// RESOLUTION MATRIX — the target triples we support, mapped to each tool's release asset. Versions
// are PINNED; `sha256` MUST be filled with the upstream published checksum before a triple actually
// stages (an empty sha ⇒ we refuse to write an unverified binary — the honest floor). Filling the
// real checksums + committing the fetched binaries + wiring `externalBin`/resources is the DEFERRED
// half of #1277.
const GH_VERSION = "2.62.0";
const gh = (assetOs, assetArch, ext) => ({
  // The `gh` release asset URL (MIT — freely redistributable; ship the notice).
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${assetOs}_${assetArch}.${ext}`,
  // TODO(#1277): the upstream SHA-256 for this asset (from the release's checksums.txt). Empty ⇒ skip.
  sha256: "",
  archive: ext, // "zip" | "tar.gz" | "msi" — extraction is the deferred step
});
// PortableGit (Windows only): a self-extracting 7z. GPLv2 (git) + GPLv3 (bash/coreutils) — mere
// aggregation, but ships the licenses + a written source offer (see src-tauri/licenses/).
const PORTABLE_GIT_VERSION = "2.47.1";
const portableGit = (arch) => ({
  url: `https://github.com/git-for-windows/git/releases/download/v${PORTABLE_GIT_VERSION}.windows.1/PortableGit-${PORTABLE_GIT_VERSION}-${arch}.7z.exe`,
  sha256: "", // TODO(#1277): upstream SHA-256; empty ⇒ skip.
  archive: "7z.exe",
});
/** win/mac/linux × x64/arm64 → the tools each triple needs. `gh` everywhere; PortableGit on Windows. */
const TOOLCHAIN = {
  "x86_64-pc-windows-msvc": { gh: gh("windows", "amd64", "zip"), portableGit: portableGit("64-bit") },
  "aarch64-pc-windows-msvc": { gh: gh("windows", "arm64", "zip"), portableGit: portableGit("arm64") },
  "x86_64-apple-darwin": { gh: gh("macOS", "amd64", "zip") },
  "aarch64-apple-darwin": { gh: gh("macOS", "arm64", "zip") },
  "x86_64-unknown-linux-gnu": { gh: gh("linux", "amd64", "tar.gz") },
  "aarch64-unknown-linux-gnu": { gh: gh("linux", "arm64", "tar.gz") },
};

/** Fetch `url` to a Buffer and verify its SHA-256; throws on a mismatch. Best-effort caller wraps it. */
async function fetchVerified(url, sha256) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${got}`);
  return buf;
}

/** Stage the host toolchain for one triple — opt-in, best-effort (warns + continues on any failure). */
async function stageToolchain(triple, outDir) {
  if (process.env.BSC_STAGE_TOOLCHAIN !== "1") {
    return; // default: never touch the network — the existing sidecar staging is the only work.
  }
  const entry = TOOLCHAIN[triple];
  if (!entry) {
    console.warn(`[toolchain] no resolution-matrix entry for ${triple}; skipping`);
    return;
  }
  for (const [tool, spec] of Object.entries(entry)) {
    try {
      if (!spec.sha256) {
        // The honest floor: we never stage an unverified binary. Filling the real upstream checksum
        // (and the archive-extraction + externalBin/resources wiring) is the deferred half of #1277.
        console.warn(`[toolchain] ${tool} for ${triple}: no pinned sha256 yet — skipping (deferred).`);
        continue;
      }
      const buf = await fetchVerified(spec.url, spec.sha256);
      // NOTE: `gh`/PortableGit ship as archives (zip/tar.gz/7z.exe); extracting them into the layout
      // the runtime resolver expects (`<exe_dir>/gh[.exe]`, `<exe_dir>/portable-git/...`) is the
      // deferred extraction step. We write the raw archive next to the sidecars so the release
      // workflow can pick it up; extraction/verify + `externalBin`/resources wiring lands with the
      // real binaries.
      const raw = join(outDir, `${tool}-${triple}.${spec.archive}`);
      writeFileSync(raw, buf);
      console.log(`[toolchain] fetched+verified ${tool} for ${triple} -> ${raw} (extraction deferred)`);
    } catch (e) {
      console.warn(`[toolchain] ${tool} for ${triple} failed (best-effort, continuing): ${e.message}`);
    }
  }
}

// Runs after the sidecar staging above. Awaited but guarded, so it can never fail the build.
if (triple === "universal-apple-darwin") {
  await stageToolchain("aarch64-apple-darwin", outDir);
  await stageToolchain("x86_64-apple-darwin", outDir);
} else {
  await stageToolchain(triple, outDir);
}
