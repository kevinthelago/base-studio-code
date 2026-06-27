// Parity guard (#1763): the canonical bundled-sidecar set lives in ONE place —
// `src-tauri/tauri.conf.json`'s `bundle.externalBin`. `build.rs` and `scripts/stage-sidecar.mjs`
// now DERIVE their list from it, but `package.json`'s `build:plan` (the dev convenience that
// compiles every sidecar in one `cargo build`) still hand-lists each bin via `--bin` flags.
//
// A missing `--bin` there is silent in dev, so this test asserts the `build:plan` `--bin` set
// equals the `externalBin` set. Adding a sidecar to `externalBin` without updating `build:plan`
// fails here instead of skewing dev builds.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Sidecar names from `tauri.conf.json`'s `bundle.externalBin`, `binaries/` prefix stripped. */
function externalBinNames(): string[] {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const ext: string[] = conf?.bundle?.externalBin ?? [];
  return ext.map((p) => p.replace(/^binaries\//, ""));
}

/** Sidecar names from `package.json`'s `build:plan` script (`--bin <name>` flags). */
function buildPlanBins(): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script: string = pkg?.scripts?.["build:plan"] ?? "";
  const names: string[] = [];
  const re = /--bin\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) names.push(m[1]);
  return names;
}

describe("sidecar parity: build:plan ⟷ externalBin", () => {
  it("build:plan's --bin set equals the externalBin set", () => {
    const external = externalBinNames();
    const plan = buildPlanBins();

    // Order-independent set equality, and no accidental dupes in either list.
    expect([...plan].sort()).toEqual([...external].sort());
    expect(new Set(plan).size).toBe(plan.length);
    expect(new Set(external).size).toBe(external.length);
  });
});
