// Unit tests for the pure parked-worktree cap selection. These cover the guards that decide what
// may be DELETED — a mistake here removes someone's working tree, so every exclusion is pinned.
import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_IDLE_MS, isCollectable, isParked, planCap } from "./worktree-pool-plan.mjs";

const tree = (
  name: string,
  branch: string | null,
  lastBuiltMs = 0,
  blocked: string | null = null
) => ({ name, branch, lastBuiltMs, blocked });

describe("isParked", () => {
  it("matches only the parked-<x> convention", () => {
    expect(isParked("parked-ddbcache")).toBe(true);
    expect(isParked("develop")).toBe(false);
    expect(isParked("parked-")).toBe(false); // needs a suffix
    expect(isParked("unparked-thing")).toBe(false);
    expect(isParked("feature/parked-thing")).toBe(false); // must not match mid-name
    expect(isParked(null)).toBe(false); // detached HEAD
  });
});

describe("planCap", () => {
  it("never removes the main tree or an ACTIVE ref, whatever the keep count", () => {
    const { remove, keep } = planCap(
      [
        tree("/repo", "develop", 100),
        tree("/repo/wt-order", "requestsessionsmount-is-order-dependent", 50),
        tree("/repo/wt-a", "parked-a", 10),
        tree("/repo/wt-b", "parked-b", 20),
        tree("/repo/wt-c", "parked-c", 30),
      ],
      { keep: 0 }
    );
    expect(keep).toContain("/repo");
    expect(keep).toContain("/repo/wt-order");
    expect(remove).toEqual(["/repo/wt-a", "/repo/wt-b", "/repo/wt-c"]);
  });

  it("keeps the N most recently BUILT parked trees, not the most recently committed", () => {
    const { remove, keep } = planCap(
      [
        tree("/wt-old", "parked-old", 1),
        tree("/wt-mid", "parked-mid", 5),
        tree("/wt-new", "parked-new", 9),
      ],
      { keep: 2 }
    );
    expect(keep).toEqual(["/wt-new", "/wt-mid"]);
    expect(remove).toEqual(["/wt-old"]);
  });

  it("removes oldest-first, so a partial run drops the least valuable trees", () => {
    const { remove } = planCap(
      [tree("/a", "parked-a", 30), tree("/b", "parked-b", 10), tree("/c", "parked-c", 20)],
      { keep: 0 }
    );
    expect(remove).toEqual(["/b", "/c", "/a"]);
  });

  /** The hazard that justifies a THIRD outcome. Silently skipping a blocked tree would leave the
   *  caller believing the pool was capped when it was not — so it is reported, and never removed. */
  it("refuses a blocked tree instead of removing or silently skipping it", () => {
    const { remove, refused, keep } = planCap(
      [
        tree("/wt-junction", "parked-junction", 1, "node_modules is a symlink/junction"),
        tree("/wt-fine", "parked-fine", 2),
      ],
      { keep: 0 }
    );
    expect(remove).toEqual(["/wt-fine"]);
    expect(refused).toEqual([
      { name: "/wt-junction", why: "node_modules is a symlink/junction" },
    ]);
    expect(keep).not.toContain("/wt-junction"); // reported, not quietly counted as kept
  });

  it("removes nothing when the pool is already at or under the cap", () => {
    const { remove } = planCap([tree("/a", "parked-a", 1), tree("/b", "parked-b", 2)], { keep: 2 });
    expect(remove).toEqual([]);
  });

  it("defaults to keeping 2", () => {
    const { remove } = planCap([
      tree("/a", "parked-a", 1),
      tree("/b", "parked-b", 2),
      tree("/c", "parked-c", 3),
    ]);
    expect(remove).toEqual(["/a"]);
  });
});

// ── Merged trees are collectable too (2026-08-29) ────────────────────────────
//
// The `parked-*`-only rule is why the pool reached 64 trees holding 631 GB. CLAUDE.md step 7 offers
// "recycle onto the next ref OR park", and in practice an agent merges its branch and stops, leaving
// the tree on its own WORK branch. Measured that day: of 23 merged trees only 3 were on `parked-*`,
// so 20 (~380 GB) could never be seen by this janitor.

const idle = (name: string, branch: string | null, opts: Record<string, unknown> = {}) => ({
  name,
  branch,
  lastBuiltMs: 0,
  lastActiveMs: 0,
  blocked: null,
  ...opts,
});

describe("isCollectable", () => {
  it("accepts a parked branch OR a merged one, and rejects an unlanded ref", () => {
    expect(isCollectable({ branch: "parked-x" })).toBe(true);
    expect(isCollectable({ branch: "148-tests-set", merged: true })).toBe(true);
    expect(isCollectable({ branch: "148-tests-set", merged: false })).toBe(false);
    expect(isCollectable({ branch: "148-tests-set" })).toBe(false); // absent ⇒ not merged
  });

  /// THE REGRESSION THIS EXISTS FOR. `git merge-base --is-ancestor develop develop` is TRUE, so
  /// widening the rule from `parked-*` to "merged" made the MAIN WORKTREE a deletion candidate. The
  /// old naming test had excluded it only as a side effect. Found by running the widened janitor with
  /// its idle guard disabled, which proposed removing the repository itself.
  it("NEVER accepts the main tree or an integration branch, however merged they look", () => {
    expect(isCollectable({ branch: "develop", merged: true })).toBe(false);
    expect(isCollectable({ branch: "main", merged: true })).toBe(false);
    expect(isCollectable({ branch: "master", merged: true })).toBe(false);
    expect(isCollectable({ branch: "parked-x", isMain: true })).toBe(false);
    expect(isCollectable({ branch: "anything", merged: true, isMain: true })).toBe(false);
  });
});

describe("planCap activity guard", () => {
  const HOUR = 60 * 60 * 1000;

  /// MERGED IS NOT IDLE. A session merges its branch and keeps working in the same tree — the tree
  /// this fix was written in was on a merged branch while it was being written. Without this guard,
  /// collecting merged trees deletes a working tree out from under a live agent.
  it("keeps a merged tree that someone is still working in", () => {
    const now = 100 * HOUR;
    const { remove, keep } = planCap(
      [
        idle("/wt-live", "landed-an-hour-ago", { merged: true, lastActiveMs: now - 1 * HOUR }),
        idle("/wt-cold", "landed-last-week", { merged: true, lastActiveMs: now - 90 * HOUR }),
      ],
      { keep: 0, now }
    );
    expect(remove).toEqual(["/wt-cold"]);
    expect(keep).toContain("/wt-live");
  });

  it("counts a long compile as activity, so a building tree is not collected", () => {
    const now = 100 * HOUR;
    const { remove } = planCap(
      [idle("/wt-building", "landed", { merged: true, lastBuiltMs: now - 1 * HOUR, lastActiveMs: 0 })],
      { keep: 0, now }
    );
    expect(remove).toEqual([]);
  });

  it("keeps an in-use tree rather than REFUSING it — being busy is not a hazard", () => {
    const now = 100 * HOUR;
    const { refused, keep } = planCap(
      [idle("/wt-live", "landed", { merged: true, lastActiveMs: now, blocked: "junction" })],
      { keep: 0, now }
    );
    expect(refused).toEqual([]); // never even reaches the hazard check
    expect(keep).toContain("/wt-live");
  });

  it("still spares the `keep` newest among collectable idle trees", () => {
    const now = 1000 * HOUR;
    const { remove } = planCap(
      [
        idle("/a", "x", { merged: true, lastBuiltMs: 1, lastActiveMs: 1 }),
        idle("/b", "y", { merged: true, lastBuiltMs: 2, lastActiveMs: 2 }),
        idle("/c", "parked-c", { lastBuiltMs: 3, lastActiveMs: 3 }),
      ],
      { keep: 1, now }
    );
    expect(remove).toEqual(["/a", "/b"]); // oldest first; /c is the warmest and survives
  });
});

/**
 * The idle guard has to be shorter than a session, or the janitor is a no-op on the only pool that
 * grows.
 *
 * MEASURED 2026-09-01: at the previous 12 hours nothing here was ever eligible — a parked tree is
 * reclaimed by the next session that wants one, at roughly 20 minutes — so `cap-worktrees` reported
 * "nothing to remove" while 227 GB sat in eight parked trees. Sessions run 30 minutes to 4 hours, so
 * the guard is pinned BETWEEN the longest session and half a day: long enough that a working tree is
 * never taken, short enough that an abandoned one is.
 */
describe("the idle guard is scaled to a session, not to a day", () => {
  it("is longer than the longest session and well under half a day", () => {
    const hours = DEFAULT_MIN_IDLE_MS / 3_600_000;
    expect(hours).toBeGreaterThan(4);
    expect(hours).toBeLessThanOrEqual(8);
  });

  it("would still have spared a tree touched inside a session, and collected one left overnight", () => {
    const now = Date.parse("2026-09-01T18:00:00Z");
    const tree = (name: string, hoursAgo: number) => ({
      name: `/repo/${name}`,
      branch: `parked-${name}`,
      lastBuiltMs: now - hoursAgo * 3_600_000,
      lastActiveMs: now - hoursAgo * 3_600_000,
    });
    // keep: 0 so the age guard is the only thing deciding.
    const { remove } = planCap([tree("fresh", 1), tree("stale", 9)], { keep: 0, now });
    expect(remove).toContain("/repo/stale");
    expect(remove).not.toContain("/repo/fresh");
  });
});
