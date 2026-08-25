// The sidecar binaries a build is expected to emit — ONE derivation, three readers.
//
// Taken from `tauri.conf.json`'s `bundle.externalBin`, which is what actually ships, rather than
// restated in each script that needs the list. `verify-build-artifacts.mjs` already gave the reason a
// restatement is dangerous: `bsc-hook` is newer than `build:plan`'s original two, so a hardcoded pair
// would have silently excused it from every check. A second copy here for the publisher would put that
// hazard straight back.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every sidecar name (no `binaries/` prefix, no `.exe`), from the canonical bundle list. */
export function expectedBins(repoRoot) {
  const conf = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const ext = conf?.bundle?.externalBin;
  if (!Array.isArray(ext) || ext.length === 0) {
    throw new Error("no bundle.externalBin array in tauri.conf.json — cannot know what to verify");
  }
  return ext.map((p) => p.replace(/^binaries\//, ""));
}
