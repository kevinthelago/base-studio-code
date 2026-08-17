// Unit tests for the pure parked-worktree cap selection. These cover the guards that decide what
// may be DELETED — a mistake here removes someone's working tree, so every exclusion is pinned.
import { describe, expect, it } from "vitest";
import { isParked, planCap } from "./worktree-pool-plan.mjs";

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
