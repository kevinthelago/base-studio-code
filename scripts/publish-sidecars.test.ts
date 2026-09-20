// The publish POLICY — what may be handed to every session as `$BSC_BIN`, and what may not.
//
// The fs half (copy → chmod → rename) is three calls and is exercised for real by `build:plan` on
// every build; what is worth pinning is the decision, because each refusal here corresponds to a
// failure that has actually happened and cost a session hours of wrong diagnosis.
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { copyPreservingMtime, publishDecision, stagingPathFor, HANDSHAKE_ARGS, handshakeVerdict } from "./publish-sidecars.mjs";
import { classifyArtifact } from "./build-artifact-plan.mjs";

type Stat = { size: number; mode: number; isFile: boolean } | null;
const good: Stat = { size: 261_000_000, mode: 0o755, isFile: true };
const verdictFor = (name: string, stat: Stat) => classifyArtifact({ name, path: `/t/${name}` }, stat);

describe("publish-sidecars: what may become $BSC_BIN", () => {
  it("publishes a verified binary that identifies itself", () => {
    const d = publishDecision(verdictFor("bsc", good), { handshakes: true });
    expect(d.publish).toBe(true);
  });

  it("refuses exactly what the VERIFIER refuses — one rule, not a second opinion", () => {
    // Reusing `classifyArtifact` is the point: a binary this refuses is precisely one that failed
    // verification. A parallel rule here would eventually disagree, and the disagreement would be
    // invisible — a binary the verifier rejected and the publisher shipped anyway.
    const stats: Stat[] = [
      null,                                          // never emitted
      { size: 0, mode: 0o755, isFile: true },        // truncated by a concurrent build
      { size: 12, mode: 0o755, isFile: true },       // a stub, not a linked binary
      { size: 261_000_000, mode: 0o644, isFile: true }, // present, correct, cannot exec
    ];
    for (const stat of stats) {
      const d = publishDecision(verdictFor("bsc", stat), { handshakes: true });
      expect(d.publish, `stat ${JSON.stringify(stat)}`).toBe(false);
      expect(d.reason).not.toBe("");
    }
  });

  it("refuses a `bsc` that runs but cannot say what it is", () => {
    // The size checks pass the moment a bad artifact is a stub rather than empty, and through bash a
    // non-binary file runs as a shell script. This is the check that separates "a file of the right
    // size" from "a binary that works", and it is why the failure it prevents reads as `unknown
    // command` in a session rather than as a broken build.
    const d = publishDecision(verdictFor("bsc", good), { handshakes: false });
    expect(d.publish).toBe(false);
    expect(d.reason).toContain("did not identify itself");
  });

  it("does NOT demand a handshake from a sidecar that has no `version` verb", () => {
    // `bsc-hook` is a PreToolUse hook that reads stdin; asking it to identify itself would refuse a
    // perfectly good binary and leave the cage without its permission floor.
    expect(publishDecision(verdictFor("bsc-hook", good), { handshakes: false }).publish).toBe(true);
    expect(publishDecision(verdictFor("bsc-agent", good), { handshakes: false }).publish).toBe(true);
  });
});

describe("publish-sidecars: the staging path", () => {
  it("puts the temp file in the DESTINATION's own directory", () => {
    // Same directory ⇒ same filesystem ⇒ the rename cannot fail with EXDEV. A temp under /tmp would
    // work on a machine where /tmp and ~ share a mount and fail on one where they do not, which is the
    // worst kind of bug to ship.
    const tmp = stagingPathFor("/home/u/.base-studio-code/bin/bsc", 4242);
    expect(tmp.startsWith("/home/u/.base-studio-code/bin/")).toBe(true);
    expect(tmp).toContain("bsc");
  });

  it("tags the temp with the pid, so two concurrent builds cannot collide on it", () => {
    const a = stagingPathFor("/d/bsc", 1);
    const b = stagingPathFor("/d/bsc", 2);
    expect(a).not.toBe(b);
  });

  it("hides the temp with a leading dot, so a half-written file is not mistaken for a sidecar", () => {
    expect(stagingPathFor("/d/bsc", 7)).toContain("/.bsc.");
  });
});

describe("publish-sidecars: mtime preservation (#187)", () => {
  it("gives the copy the SOURCE's mtime, not the moment it was copied", () => {
    // `copyFileSync` alone stamps the destination with "now" — the exact bug (#187): a staged copy
    // read as a few seconds NEWER than the build that produced it, which the boot-side staleness check
    // in src-tauri/src/console/pty/env.rs then read as a different, newer build and refused to
    // re-stage a byte-identical rebuild.
    const dir = mkdtempSync(join(tmpdir(), "bsc-publish-mtime-"));
    try {
      const src = join(dir, "bsc");
      writeFileSync(src, "not a real binary");
      // Force the source's mtime to a moment clearly in the past, so "did the copy preserve it" and
      // "is the copy merely recent" can never be confused.
      const built = new Date(Date.now() - 120_000);
      utimesSync(src, built, built);

      const tmp = join(dir, ".bsc.publishing-test");
      copyPreservingMtime(src, tmp);

      expect(statSync(tmp).mtime.getTime()).toBe(built.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A NOUN FOLD MOVED THIS VERB ONCE and nothing noticed: `version` folded into `self` (2026-09-20), the
   *  handshake kept asking `bsc version`, and every new binary was refused as "incoherent" — so the app ran a
   *  two-day-old `bsc` whose verbs the Jobs screen called and did not find. The handshake must accept whatever
   *  spelling the surface currently uses. */
  it("names itself through a verb the binary still has, whatever the nouns were folded into", () => {
    // The CURRENT surface answers; an old one answered differently. Both must pass, or a fold breaks staging.
    const current = (args: string[]) => (args.join(" ") === "self version" ? "bsc 0.1.0\n  built 2026-09-20" : null);
    const older = (args: string[]) => (args.join(" ") === "version" ? "bsc 0.1.0\n  built 2026-09-01" : null);
    expect(handshakeVerdict(current)).toBe(true);
    expect(handshakeVerdict(older)).toBe(true);
    // A binary that answers to NOTHING, or answers as something else, is still refused.
    expect(handshakeVerdict(() => null)).toBe(false);
    expect(handshakeVerdict(() => "bash: line 1: syntax error")).toBe(false);
    expect(HANDSHAKE_ARGS[0]).toEqual(["self", "version"], "the current spelling is tried first");
  });
});
