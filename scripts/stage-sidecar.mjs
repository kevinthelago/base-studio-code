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
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ghArchiveMember,
  ghStagedName,
  portableGitDir,
  scratchArchiveName,
  sevenZipSfxArgs,
} from "./toolchain-layout.mjs";

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
// `BSC_STAGE_TOOLCHAIN=1`, and every step (fetch + checksum-verify + extract) is wrapped so a
// network/verify/extract failure only WARNS and continues — it must never break the existing sidecar
// staging above or the `tauri build` it runs under. `gh` is NOT in `tauri.conf.json`'s `externalBin`
// yet, and `portable-git/` is not in `bundle.resources` yet (referencing a missing binary/resource
// fails the build, and these binaries are only staged at release time, not committed) — so this
// fetches+verifies+EXTRACTS into the beside-the-exe layout, but the live `externalBin`/`resources`
// wiring is the documented final release-time step (see the PR / issue #1277).
//
// RESOLUTION MATRIX — the target triples we support, mapped to each tool's release asset. Versions
// are PINNED and every `sha256` carries the upstream published checksum (a WRONG checksum breaks the
// fetch, so an empty sha still means "skip this asset — honest floor"). The SHA-256s below are the
// verbatim upstream values: `gh` from its release `gh_<ver>_checksums.txt`; PortableGit from the
// git-for-windows `v<ver>.windows.1` release notes. What stays DEFERRED to the maintainer's release
// pass: committing the extracted binaries + wiring `externalBin`/`bundle.resources` for them (Tauri
// fails a build referencing a missing binary, so that can't be dev-build-green here).
const GH_VERSION = "2.62.0";
const gh = (assetOs, assetArch, ext, sha256) => ({
  tool: "gh",
  // The `gh` release asset URL (MIT — freely redistributable; ship the notice).
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${assetOs}_${assetArch}.${ext}`,
  sha256,
  archive: ext, // "zip" (win/mac) | "tar.gz" (linux)
  // The binary's path INSIDE the archive, resolved by the pure layout builder.
  member: ghArchiveMember(GH_VERSION, assetOs, assetArch),
});
// PortableGit (Windows only): a self-extracting 7z. GPLv2 (git) + GPLv3 (bash/coreutils) — mere
// aggregation, but ships the licenses + a written source offer (see src-tauri/licenses/).
const PORTABLE_GIT_VERSION = "2.47.1";
const portableGit = (arch, sha256) => ({
  tool: "portableGit",
  url: `https://github.com/git-for-windows/git/releases/download/v${PORTABLE_GIT_VERSION}.windows.1/PortableGit-${PORTABLE_GIT_VERSION}-${arch}.7z.exe`,
  sha256,
  archive: "7z.exe",
});
/** win/mac/linux × x64/arm64 → the tools each triple needs. `gh` everywhere; PortableGit on Windows.
 *  SHA-256s: gh from https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_checksums.txt;
 *  PortableGit from https://github.com/git-for-windows/git/releases/tag/v2.47.1.windows.1 . */
const TOOLCHAIN = {
  "x86_64-pc-windows-msvc": {
    gh: gh("windows", "amd64", "zip", "7fd29acdf2714d0129b7aedde215fa12e1cfb3ad5d39280893259bdeeceba209"),
    portableGit: portableGit("64-bit", "4f3f21f4effcb659566883ee1ed3ae403e5b3d7a0699cee455f6cd765e1ac39c"),
  },
  "aarch64-pc-windows-msvc": {
    gh: gh("windows", "arm64", "zip", "650a27ca2475858cbaab3476b475ddaabc262aa3d4ff2242b6eb0498084e9f38"),
    portableGit: portableGit("arm64", "d366f44ef2b65e11f7b5a1430ae43aceb5f7c640150f325fa4b767f6da472845"),
  },
  "x86_64-apple-darwin": {
    gh: gh("macOS", "amd64", "zip", "cd547c05c175a79e5af6f95ba4881a11ca550c0ff37a63f234bc5c79a58435d5"),
  },
  "aarch64-apple-darwin": {
    gh: gh("macOS", "arm64", "zip", "fdb77f31b8a6dd23c3fd858758d692a45f7fc76383e37d475bdcae038df92afc"),
  },
  "x86_64-unknown-linux-gnu": {
    gh: gh("linux", "amd64", "tar.gz", "41c8b0698ad3003cb5c44bde672a1ffd5f818595abd80162fbf8cc999418446a"),
  },
  "aarch64-unknown-linux-gnu": {
    gh: gh("linux", "arm64", "tar.gz", "a165413209aab98bfb1db9629b97bc9c59778d38bb7378a33a0363cf822e7965"),
  },
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

/** Extract an archive (`.zip` / `.tar.gz`) at `archivePath` into `destDir`, using the platform's
 *  bundled `tar`. Modern Windows + macOS ship bsdtar, which reads zip AND tar.gz; GNU tar on Linux
 *  reads tar.gz (the only archive kind we hand it there — the linux `gh` asset is a tarball). */
function extractArchive(archivePath, destDir, archiveExt) {
  mkdirSync(destDir, { recursive: true });
  if (archiveExt === "tar.gz") {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "inherit" });
  } else if (archiveExt === "zip") {
    // bsdtar (win/mac) extracts zip via -xf; if a runner's tar can't, this throws and the
    // best-effort caller warns. (gh ships zip only on win/mac, both of which have bsdtar.)
    execSync(`tar -xf "${archivePath}" -C "${destDir}"`, { stdio: "inherit" });
  } else {
    throw new Error(`unsupported archive kind: ${archiveExt}`);
  }
}

/** Fetch+verify `gh`, unpack it, and place its binary at `<outDir>/gh-<triple>[.exe]` — the Tauri
 *  externalBin staged name a future `externalBin: ["binaries/gh"]` flip would resolve. Best-effort. */
async function stageGh(triple, spec, outDir) {
  const buf = await fetchVerified(spec.url, spec.sha256);
  const scratchArchive = join(outDir, scratchArchiveName("gh", triple, spec.archive));
  const scratchDir = join(outDir, `.gh-${triple}.extract`);
  try {
    writeFileSync(scratchArchive, buf);
    extractArchive(scratchArchive, scratchDir, spec.archive);
    const extracted = join(scratchDir, ...spec.member.split("/"));
    if (!existsSync(extracted)) {
      throw new Error(`gh binary not found at expected archive member ${spec.member}`);
    }
    const staged = join(outDir, ghStagedName(triple));
    copyFileSync(extracted, staged);
    console.log(`[toolchain] staged gh for ${triple} -> ${staged}`);
  } finally {
    rmSync(scratchArchive, { force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Fetch+verify PortableGit and run its 7z self-extractor into `<outDir>/portable-git/` — the layout
 *  the runtime resolver (env.rs `portable_git_bin_candidates`) expects beside the app exe. The SFX is
 *  a Windows .exe, so extraction only runs on a Windows host; off-Windows we warn (the release
 *  Windows leg does the real extraction). Best-effort. */
async function stagePortableGit(triple, spec, outDir) {
  const buf = await fetchVerified(spec.url, spec.sha256);
  const scratchArchive = join(outDir, scratchArchiveName("portable-git", triple, spec.archive));
  const destDir = portableGitDir(outDir);
  try {
    writeFileSync(scratchArchive, buf);
    if (process.platform !== "win32") {
      console.warn(
        `[toolchain] portable-git for ${triple}: fetched+verified, but the 7z SFX only extracts on ` +
          `Windows — extraction skipped on ${process.platform} (release Windows leg does it).`,
      );
      return;
    }
    mkdirSync(destDir, { recursive: true });
    // The SFX is an executable that self-extracts; -o<dir> (no space) + -y run it silently.
    execSync(`"${scratchArchive}" ${sevenZipSfxArgs(destDir).join(" ")}`, { stdio: "inherit" });
    console.log(`[toolchain] staged portable-git for ${triple} -> ${destDir}`);
  } finally {
    rmSync(scratchArchive, { force: true });
  }
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
  for (const spec of Object.values(entry)) {
    try {
      if (!spec.sha256) {
        // The honest floor: we never fetch an unverified asset (a missing checksum ⇒ skip).
        console.warn(`[toolchain] ${spec.tool} for ${triple}: no pinned sha256 — skipping.`);
        continue;
      }
      if (spec.tool === "gh") {
        await stageGh(triple, spec, outDir);
      } else if (spec.tool === "portableGit") {
        await stagePortableGit(triple, spec, outDir);
      }
    } catch (e) {
      console.warn(`[toolchain] ${spec.tool} for ${triple} failed (best-effort, continuing): ${e.message}`);
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
