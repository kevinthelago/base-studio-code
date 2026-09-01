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

/**
 * THE FLOOR IS NOT A FLOOR — it is a blanket exemption, and that is why the default matters so much.
 *
 * `planPrune` keeps an entry when it is newest-per-crate OR newer than the cutoff. The OR is correct
 * (both clauses are safety conditions) but it means every directory younger than the cutoff survives
 * regardless of `keep`. At the old 3-day default, a tree built today had nothing eligible at all:
 * MEASURED 2026-09-01, 0 of 266 dirs, on a repo holding 310 GB of incremental.
 *
 * These pin the SHAPE, so a future edit cannot restore a cutoff that exempts a working day.
 */
describe("the age cutoff has to be shorter than a working session", () => {
  const now = Date.parse("2026-09-01T18:00:00Z");
  const entry = (name: string, hoursAgo: number) => ({ name, mtimeMs: now - hoursAgo * 3_600_000 });

  it("collects a cache untouched for a working day, keeping the newest per crate", () => {
    const entries = [
      entry("bsc_graph-1aaaaaaaaaaaa", 0.1), // the live cache for this crate
      entry("bsc_graph-2bbbbbbbbbbbb", 8),
      entry("bsc_graph-3ccccccccccc", 30),
    ];
    const { prune, keep } = planPrune(entries, { days: 6 / 24, keep: 1, now });
    expect(keep).toContain("bsc_graph-1aaaaaaaaaaaa");
    expect(prune).toEqual(["bsc_graph-3ccccccccccc", "bsc_graph-2bbbbbbbbbbbb"]); // oldest-first
  });

  it("spares everything at the old three-day cutoff — the no-op this default replaced", () => {
    const entries = [entry("s-aaa-1", 0.1), entry("bsc_graph-2bbbbbbbbbbbb", 8), entry("s-aaa-3", 30)];
    expect(planPrune(entries, { days: 3, keep: 1, now }).prune).toEqual([]);
  });

  /** The live cache is spared by IDENTITY, not by age, so a build writing right now is never a
   *  candidate however short the cutoff gets. That is what makes a six-hour floor safe. */
  it("never prunes the newest cache for a crate even when it is older than the cutoff", () => {
    const entries = [entry("bsc_data-1ddddddddddd", 100), entry("bsc_data-2eeeeeeeeeee", 200)];
    const { prune, keep } = planPrune(entries, { days: 6 / 24, keep: 1, now });
    expect(keep).toEqual(["bsc_data-1ddddddddddd"]);
    expect(prune).toEqual(["bsc_data-2eeeeeeeeeee"]);
  });
});
