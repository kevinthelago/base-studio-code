// "Can I trust this `bsc`?" — asked from outside the binary.
//
// The whole reason this module exists is that the interesting failures CANNOT answer for themselves, so
// every case below is about distinguishing a real answer from a convincing absence of one.
import { describe, it, expect } from "vitest";
import { candidatePaths, inspect, freshness, humanizeMs, pickUsable } from "./bscBinary.mjs";
import { join } from "node:path";

const ok = (stdout = "bsc 0.1.0\n  built 2026-08-20 01:19:35 UTC") => () => ({ status: 0, stdout });
const sizes = (map: Record<string, number | null>) => (p: string) => (p in map ? map[p] : null);

describe("candidatePaths", () => {
  it("prefers a locally built binary over the staged one", () => {
    const paths = candidatePaths("/repo", "/home", join);
    expect(paths[0]).toMatch(/target[\\/]debug/);
    expect(paths[1]).toMatch(/target[\\/]release/);
    expect(paths[2]).toMatch(/\.base-studio-code[\\/]bin/);
  });
});

describe("inspect", () => {
  /**
   * THE CASE THAT MOTIVATED ALL OF THIS. A broken or interrupted link leaves a zero-length file, and
   * bash — unable to exec a file with no valid PE header — falls back to running it as a SHELL SCRIPT.
   * An empty script exits 0 printing nothing, so every command against it reads as a pass. Measured:
   * a 0-byte `bsc.exe` produced three confident, entirely wrong conclusions before `ls -l` caught it.
   */
  it("names a ZERO-BYTE binary and never executes it", () => {
    let ran = false;
    const r = inspect("/repo/bsc", {
      statSize: () => 0,
      run: () => {
        ran = true;
        return { status: 0, stdout: "" };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("zero-byte");
    expect(r.detail).toMatch(/exits 0 printing nothing/);
    expect(ran, "a zero-byte file must not be executed — running it is what produces the false pass").toBe(false);
  });

  it("distinguishes absent from broken", () => {
    const r = inspect("/nope", { statSize: () => null, run: ok() });
    expect(r.state).toBe("absent");
  });

  /** The incoherent-build case: it runs, exits 0, and says nothing. */
  it("rejects a binary that runs but does not identify itself", () => {
    const r = inspect("/repo/bsc", { statSize: () => 5_000, run: () => ({ status: 0, stdout: "" }) });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("no-handshake");
  });

  it("rejects output that is not a bsc identity, however successful the exit", () => {
    const r = inspect("/repo/bsc", { statSize: () => 5_000, run: () => ({ status: 0, stdout: "hello" }) });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("no-handshake");
  });

  it("accepts a real handshake and reports the version line", () => {
    const r = inspect("/repo/bsc", { statSize: () => 69_000_000, run: ok() });
    expect(r.ok).toBe(true);
    expect(r.version).toBe("bsc 0.1.0");
  });
});

describe("freshness", () => {
  it("reports STALE when the binary predates the newest source change", () => {
    const f = freshness(1_000, 5_000);
    expect(f.known).toBe(true);
    expect(f.stale).toBe(true);
    expect(f.behindMs).toBe(4_000);
  });

  it("is not stale when the binary is newer", () => {
    expect(freshness(9_000, 5_000).stale).toBe(false);
  });

  it("declines to guess when either side is unknown", () => {
    expect(freshness(null, 5_000).known).toBe(false);
    expect(freshness(1_000, null).known).toBe(false);
  });
});

describe("humanizeMs", () => {
  it("scales the unit so the number is actionable", () => {
    expect(humanizeMs(45_000)).toBe("45s");
    expect(humanizeMs(3 * 60_000 + 12_000)).toBe("3m 12s");
    expect(humanizeMs(2 * 3_600_000)).toBe("2h 0m");
    expect(humanizeMs(50 * 3_600_000)).toBe("2d 2h");
  });
});

describe("pickUsable", () => {
  it("skips a zero-byte candidate and takes the next real one", () => {
    const got = pickUsable(["/a", "/b"], { statSize: sizes({ "/a": 0, "/b": 5_000 }), run: ok() });
    expect(got?.path).toBe("/b");
  });

  it("returns null when nothing is usable, so a caller can report rather than fail", () => {
    expect(pickUsable(["/a"], { statSize: () => 0, run: ok() })).toBeNull();
  });
});
