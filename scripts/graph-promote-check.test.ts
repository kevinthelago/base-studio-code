// The gate's repo-store drift check — specifically, how it picks a `bsc` to run.
//
// This is small but load-bearing: the check is INFRASTRUCTURE, so a missing binary must not redden the
// gate, while a binary that exists but cannot answer must not be trusted either. Both halves were
// learned the hard way in the same slice.
import { describe, it, expect } from "vitest";
import { candidatePaths, resolveBsc } from "./graph-promote-check.mjs";

describe("resolving a bsc to run the check with", () => {
  it("prefers a locally built binary over the staged one", () => {
    const paths = candidatePaths("/repo", "/home");
    expect(paths[0]).toMatch(/target[\\/]debug/);
    expect(paths[1]).toMatch(/target[\\/]release/);
    expect(paths[2]).toMatch(/\.base-studio-code[\\/]bin/);
  });

  /**
   * A 0-BYTE `bsc.exe` is the case that motivated this. A broken or interrupted link leaves the file in
   * place at zero length, and every command run against it exits 0 printing nothing — which reads
   * exactly like a passing check. During this slice that binary produced three confident, entirely
   * wrong conclusions about fresh-clone behaviour before `ls -l` showed it was empty.
   */
  it("SKIPS a zero-byte binary rather than trusting its silent success", () => {
    const sizes: Record<string, number> = { "/repo/target/debug/bsc": 0, "/repo/target/release/bsc": 5_000 };
    const got = resolveBsc(["/repo/target/debug/bsc", "/repo/target/release/bsc"], (p: string) => sizes[p] ?? 0);
    expect(got).toBe("/repo/target/release/bsc");
  });

  it("returns null when nothing usable exists, so the caller can report rather than fail", () => {
    expect(resolveBsc(["/a", "/b"], () => 0)).toBeNull();
  });

  it("takes the first usable candidate", () => {
    expect(resolveBsc(["/a", "/b"], () => 10)).toBe("/a");
  });
});
