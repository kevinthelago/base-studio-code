// Pure path/layout builders for the bundled host toolchain (#1277).
//
// Extracted into their own SIDE-EFFECT-FREE module so the extraction logic in
// `stage-sidecar.mjs` (which shells out + touches the fs/network) stays thin, and so these
// builders can be unit-tested without running the stager's top-level side effects
// (`scripts/toolchain-layout.test.ts`). No imports beyond `node:path`; every function is pure.

import { join } from "node:path";

/** The bare `gh` executable name for an asset OS (`gh.exe` on Windows, else `gh`). */
export function ghBinaryName(assetOs) {
  return assetOs === "windows" ? "gh.exe" : "gh";
}

/** The path of the `gh` binary INSIDE its release archive. gh's zip/tar.gz all unpack to a single
 *  top dir `gh_<version>_<os>_<arch>/` with the binary under `bin/`, e.g.
 *  `gh_2.62.0_windows_amd64/bin/gh.exe`. Returned with forward slashes (archive-internal paths). */
export function ghArchiveMember(version, assetOs, assetArch) {
  return `gh_${version}_${assetOs}_${assetArch}/bin/${ghBinaryName(assetOs)}`;
}

/** The staged on-disk name for a bundled `gh`, matching Tauri's externalBin convention
 *  (`gh-<triple>[.exe]`) so a future `externalBin: ["binaries/gh"]` flip resolves it. */
export function ghStagedName(triple) {
  const ext = triple.includes("windows") ? ".exe" : "";
  return `gh-${triple}${ext}`;
}

/** The directory the trimmed PortableGit tree extracts into, relative to the sidecar out dir.
 *  The runtime resolver (env.rs `portable_git_bin_candidates`) expects `<exe_dir>/portable-git/`,
 *  so the bundler ships this dir beside the app exe. */
export function portableGitDir(outDir) {
  return join(outDir, "portable-git");
}

/** Silent-extraction args for a Git-for-Windows PortableGit 7-Zip self-extracting archive
 *  (`PortableGit-*.7z.exe`). The 7z SFX accepts `-o<dir>` (no space) + `-y` (assume yes). */
export function sevenZipSfxArgs(destDir) {
  return [`-o${destDir}`, "-y"];
}

/** A temp scratch name (in the out dir) for a downloaded archive before extraction — kept distinct
 *  per tool+triple, dot-prefixed so it's obviously transient, and cleaned up after extraction. */
export function scratchArchiveName(tool, triple, archiveExt) {
  return `.${tool}-${triple}.${archiveExt}`;
}
