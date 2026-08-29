// The bootstrap shim's two decisions — everything else in `record-run.mjs` is process plumbing.
//
// Both cases here were found by running it, not by reading it: the `--` split (because `npm run tauri
// -- dev` carries a second one) and the capability probe (because the first candidate binary predated
// the verb, and delegating to it stopped the command it was supposed to be wrapping).
import { describe, it, expect } from "vitest";
import { splitArgs, helpAdvertisesRun, helpAdvertisesMeasureOnly } from "./record-run.mjs";

describe("record-run: splitting our flags from the child's command", () => {
  it("splits at the FIRST bare `--`, so a command carrying its own still arrives whole", () => {
    // The real wiring: `npm run tauri -- dev` has a `--` of its own. Splitting at the LAST one would
    // hand `dev` to us and run `npm run tauri` with no subcommand.
    const r = splitArgs(["--stage", "launch", "--", "npm", "run", "tauri", "--", "dev"]);
    expect(r.ok).toBe(true);
    expect(r.ours).toEqual(["--stage", "launch"]);
    expect(r.cmd).toEqual(["npm", "run", "tauri", "--", "dev"]);
  });

  it("refuses rather than guessing when there is no command", () => {
    // Taking the leading words as the command would make a forgotten `--` execute a flag.
    expect(splitArgs(["--stage", "build"]).ok).toBe(false);
    expect(splitArgs(["--stage", "build", "--"]).ok).toBe(false);
  });

  it("passes our flags through verbatim — this shim does not interpret them", () => {
    const r = splitArgs(["--stage", "compile", "--source", "x", "--project", "k", "--", "cargo", "build"]);
    expect(r.ours).toEqual(["--stage", "compile", "--source", "x", "--project", "k"]);
  });
});

describe("record-run: is this bsc capable of `errors run`?", () => {
  it("matches the verb as a MENU ROW, never as prose", () => {
    const withRun = ["COMMANDS:", "  add      record a fault occurrence", "  run      run a command; record a fault if it fails"].join("\n");
    expect(helpAdvertisesRun(withRun)).toBe(true);
  });

  it("says no for a binary that predates the verb, even though its help says 'run' in prose", () => {
    // This is the exact shape of the older help text: the word appears repeatedly in descriptions, so
    // a substring check would call every stale binary capable and the command would be swallowed.
    const old = [
      "bsc errors — the project runtime-fault store",
      "COMMANDS:",
      "  add      record a fault occurrence; prints its fingerprint",
      "  list     the fault table (lean TSV; newest-seen first)",
      "Run `bsc errors <command> help` for the args of a single command.",
    ].join("\n");
    expect(old).toContain("run");           // the trap the naive check falls into
    expect(helpAdvertisesRun(old)).toBe(false);
  });

  it("treats no output at all as incapable", () => {
    // A zero-byte binary exits 0 printing nothing. Reading that as support is how this silently
    // records nothing forever.
    expect(helpAdvertisesRun("")).toBe(false);
    expect(helpAdvertisesRun(undefined)).toBe(false);
  });
});

describe("record-run: is this bsc capable of `--measure-only`?", () => {
  // The SECOND version of the same failure the probe above exists for, and the reason it needed its
  // own check: a binary can have `run` and still predate this flag. The staged `bsc` routinely does —
  // it is refreshed only when the app boots — so the gate would hand `--measure-only` to a binary that
  // exits 1 on an unknown flag, and every leg would fail with a flag error while the code under test
  // was never compiled. A wrapper that can stop the build it wraps is worse than no wrapper.
  it("says yes only when the run help actually advertises the flag", () => {
    const withFlag = [
      "USAGE:",
      "  bsc errors run --stage <stage> [--source <tag>] [--measure-only] -- <cmd>…",
      "  --measure-only record what the command COST and file NO fault.",
    ].join("\n");
    expect(helpAdvertisesMeasureOnly(withFlag)).toBe(true);
  });

  it("says no for a run-capable binary that predates the flag", () => {
    const older = [
      "USAGE:",
      "  bsc errors run --stage <stage> [--project <key>] [--source <tag>] -- <cmd>…",
      "  --source <t>   this producer's identity; defaults to the command itself.",
    ].join("\n");
    expect(helpAdvertisesRun("COMMANDS:\n  run      wrap a command")).toBe(true);
    expect(helpAdvertisesMeasureOnly(older)).toBe(false);
  });

  it("treats no output at all as incapable", () => {
    expect(helpAdvertisesMeasureOnly("")).toBe(false);
    expect(helpAdvertisesMeasureOnly(undefined)).toBe(false);
  });
});
