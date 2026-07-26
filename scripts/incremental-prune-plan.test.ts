// Unit tests for the pure incremental-prune selection logic (#3821). These cover the two guards
// that decide what a sweep may delete — keep-newest-per-crate and the age cutoff — plus the
// name parsing, without touching a filesystem or running the CLI's top-level side effects.
import { describe, expect, it } from "vitest";
import { crateNameOf, planPrune } from "./incremental-prune-plan.mjs";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
/** `n` days before NOW. */
const daysAgo = (n: number) => NOW - n * DAY;

describe("crateNameOf", () => {
  it("splits real cargo incremental dir names at the stable-crate-id", () => {
    expect(crateNameOf("base_studio_code_lib-0n9p2yhrm5isb")).toBe("base_studio_code_lib");
    expect(crateNameOf("bsc-00d9fsk2cry13")).toBe("bsc");
    expect(crateNameOf("bsc_data-161fe4604e2c47b0")).toBe("bsc_data");
  });

  it("keeps the crate name intact — cargo underscores it, so the LAST hyphen is the split", () => {
    // `base-studio-code` is rendered `base_studio_code` here, so the name half has no hyphens.
    expect(crateNameOf("base_studio_code-2gjyo5q5fykho")).toBe("base_studio_code");
  });

  it("returns null for anything not shaped like <crate>-<id>", () => {
    expect(crateNameOf("no-id")).toBeNull(); // suffix too short to be a crate id
    expect(crateNameOf("nohyphenatall")).toBeNull();
    expect(crateNameOf("-0n9p2yhrm5isb")).toBeNull(); // empty crate name
    expect(crateNameOf("crate-NOTLOWERCASE1")).toBeNull(); // ids are [0-9a-z]
  });
});

describe("planPrune — the age cutoff", () => {
  it("prunes only what is older than the cutoff", () => {
    const { prune } = planPrune(
      [
        { name: "bsc-aaaaaaaaaaaaa", mtimeMs: daysAgo(0) },
        { name: "bsc-bbbbbbbbbbbbb", mtimeMs: daysAgo(20) },
        { name: "bsc-ccccccccccccc", mtimeMs: daysAgo(30) },
      ],
      { days: 14, now: NOW },
    );
    // Newest is spared by keep=1; the other two are both past the cutoff.
    expect(prune).toEqual(["bsc-ccccccccccccc", "bsc-bbbbbbbbbbbbb"]);
  });

  it("prunes nothing when everything is recent — a busy tree is left alone", () => {
    const { prune } = planPrune(
      [
        { name: "bsc-aaaaaaaaaaaaa", mtimeMs: daysAgo(1) },
        { name: "bsc-bbbbbbbbbbbbb", mtimeMs: daysAgo(2) },
      ],
      { days: 14, now: NOW },
    );
    expect(prune).toEqual([]);
  });

  it("never touches a directory an in-flight build just stamped", () => {
    // The concurrency guarantee: a live `cargo build` sets mtime to now, so however old the rest
    // of the tree is, the directory being written cannot be swept out from under it.
    const { prune, keep } = planPrune(
      [
        { name: "bsc-aaaaaaaaaaaaa", mtimeMs: NOW },
        { name: "bsc-bbbbbbbbbbbbb", mtimeMs: daysAgo(400) },
        { name: "bsc-ccccccccccccc", mtimeMs: daysAgo(500) },
      ],
      { days: 14, now: NOW },
    );
    expect(prune).not.toContain("bsc-aaaaaaaaaaaaa");
    expect(keep).toContain("bsc-aaaaaaaaaaaaa");
  });
});

describe("planPrune — keep-newest-per-crate", () => {
  it("spares the newest per crate even when the whole crate is past the cutoff", () => {
    // A crate nobody has rebuilt in months keeps a working cache — a sweep must not force a
    // from-scratch rebuild of something that was fine.
    const { prune, keep } = planPrune(
      [
        { name: "llm-aaaaaaaaaaaaa", mtimeMs: daysAgo(100) },
        { name: "llm-bbbbbbbbbbbbb", mtimeMs: daysAgo(200) },
      ],
      { days: 14, now: NOW },
    );
    expect(prune).toEqual(["llm-bbbbbbbbbbbbb"]);
    expect(keep).toEqual(["llm-aaaaaaaaaaaaa"]);
  });

  it("counts the survivors per crate, not across the tree", () => {
    const { prune } = planPrune(
      [
        { name: "llm-aaaaaaaaaaaaa", mtimeMs: daysAgo(100) },
        { name: "llm-bbbbbbbbbbbbb", mtimeMs: daysAgo(200) },
        { name: "plandb-ccccccccccccc", mtimeMs: daysAgo(100) },
        { name: "plandb-ddddddddddddd", mtimeMs: daysAgo(200) },
      ],
      { days: 14, now: NOW },
    );
    // One survivor EACH, not one overall.
    expect(prune.sort()).toEqual(["llm-bbbbbbbbbbbbb", "plandb-ddddddddddddd"]);
  });

  it("honours a larger keep", () => {
    const { prune } = planPrune(
      [
        { name: "llm-aaaaaaaaaaaaa", mtimeMs: daysAgo(100) },
        { name: "llm-bbbbbbbbbbbbb", mtimeMs: daysAgo(200) },
        { name: "llm-ccccccccccccc", mtimeMs: daysAgo(300) },
      ],
      { days: 14, keep: 2, now: NOW },
    );
    expect(prune).toEqual(["llm-ccccccccccccc"]);
  });
});

describe("planPrune — conservative fallbacks", () => {
  it("never prunes a directory whose name it does not recognize", () => {
    const { prune, keep } = planPrune(
      [
        { name: "something-else", mtimeMs: daysAgo(500) },
        { name: "s-hkrbnw6c7i-0hz9snw.lock", mtimeMs: daysAgo(500) },
      ],
      { days: 14, now: NOW },
    );
    expect(prune).toEqual([]);
    expect(keep.sort()).toEqual(["s-hkrbnw6c7i-0hz9snw.lock", "something-else"]);
  });

  it("returns an empty plan for an empty tree", () => {
    expect(planPrune([], { now: NOW })).toEqual({ prune: [], keep: [] });
  });

  it("reports prune oldest-first, so a truncated log shows the stalest first", () => {
    const { prune } = planPrune(
      [
        { name: "bsc-aaaaaaaaaaaaa", mtimeMs: daysAgo(0) },
        { name: "bsc-bbbbbbbbbbbbb", mtimeMs: daysAgo(50) },
        { name: "bsc-ccccccccccccc", mtimeMs: daysAgo(500) },
        { name: "bsc-ddddddddddddd", mtimeMs: daysAgo(100) },
      ],
      { days: 14, now: NOW },
    );
    expect(prune).toEqual(["bsc-ccccccccccccc", "bsc-ddddddddddddd", "bsc-bbbbbbbbbbbbb"]);
  });
});
