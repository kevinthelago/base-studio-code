// Unit tests for the pure cross-worktree dedup selection. These pin the EXCLUSIONS, because a
// mistake here links a file that should have stayed independent — the one outcome the hash check
// downstream cannot catch (it verifies the bytes match, not that linking them was appropriate).
import { describe, expect, it } from "vitest";
import { isWorkspaceCrate, planDedupe, reclaimableBytes } from "./dedupe-plan.mjs";

const NOW = 1_000_000_000_000;
const OLD = NOW - 86_400_000; // a day old — safely past any recency floor

const f = (
  tree: string,
  name: string,
  size: number,
  ino: number,
  mtimeMs: number = OLD
) => ({ tree, path: `${tree}/target/debug/deps/${name}`, name, size, mtimeMs, ino });

describe("isWorkspaceCrate", () => {
  it("matches with and without the rlib lib prefix", () => {
    const ws = new Set(["bsc_util", "base_studio_code"]);
    expect(isWorkspaceCrate("bsc_util", ws)).toBe(true); // .d / .rmeta form
    expect(isWorkspaceCrate("libbsc_util", ws)).toBe(true); // .rlib form
    expect(isWorkspaceCrate("serde_json", ws)).toBe(false);
  });

  it("does not mistake a registry crate that merely starts with lib", () => {
    // `libduckdb_sys` is a real crate name; stripping `lib` yields `duckdb_sys`, which must not
    // accidentally match a workspace crate of that name if one ever existed.
    expect(isWorkspaceCrate("libduckdb_sys", new Set(["bsc_util"]))).toBe(false);
  });
});

describe("planDedupe", () => {
  const opts = { workspaceCrates: new Set(["bsc_util"]), minAgeMs: 3600_000, now: NOW };

  it("groups the same artifact across two trees", () => {
    const groups = planDedupe(
      [f("/a", "libserde-1111111111111111.rlib", 100, 1), f("/b", "libserde-1111111111111111.rlib", 100, 2)],
      opts
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(2);
    expect(reclaimableBytes(groups)).toBe(100);
  });

  it("NEVER groups a workspace crate, in either filename form", () => {
    const groups = planDedupe(
      [
        f("/a", "libbsc_util-1111111111111111.rlib", 100, 1),
        f("/b", "libbsc_util-1111111111111111.rlib", 100, 2),
        f("/a", "bsc_util-1111111111111111.rmeta", 50, 3),
        f("/b", "bsc_util-1111111111111111.rmeta", 50, 4),
      ],
      opts
    );
    expect(groups).toEqual([]);
  });

  /** `bsc.exe` and `base_studio_code.pdb` are the names `$BSC_BIN` and humans resolve BY. Linking
   *  them would be a functional change, not a dedup. */
  it("skips un-hashed convenience copies", () => {
    const groups = planDedupe([f("/a", "bsc.exe", 100, 1), f("/b", "bsc.exe", 100, 2)], opts);
    expect(groups).toEqual([]);
  });

  it("skips files modified inside the recency floor, so a live build is never raced", () => {
    const fresh = NOW - 60_000; // one minute old
    const groups = planDedupe(
      [
        f("/a", "libserde-1111111111111111.rlib", 100, 1, fresh),
        f("/b", "libserde-1111111111111111.rlib", 100, 2, fresh),
      ],
      opts
    );
    expect(groups).toEqual([]);
  });

  it("skips groups that already share an inode, so re-running is idempotent", () => {
    const groups = planDedupe(
      [f("/a", "libserde-1111111111111111.rlib", 100, 7), f("/b", "libserde-1111111111111111.rlib", 100, 7)],
      opts
    );
    expect(groups).toEqual([]);
  });

  it("does not group differing sizes, even at the same name", () => {
    const groups = planDedupe(
      [f("/a", "libserde-1111111111111111.rlib", 100, 1), f("/b", "libserde-1111111111111111.rlib", 200, 2)],
      opts
    );
    expect(groups).toEqual([]);
  });

  it("orders by reclaimable bytes so an interrupted run has saved the most it could", () => {
    const groups = planDedupe(
      [
        f("/a", "libsmall-1111111111111111.rlib", 10, 1),
        f("/b", "libsmall-1111111111111111.rlib", 10, 2),
        f("/a", "libbig-2222222222222222.rlib", 900, 3),
        f("/b", "libbig-2222222222222222.rlib", 900, 4),
      ],
      opts
    );
    expect(groups.map((g) => g.name)).toEqual([
      "libbig-2222222222222222.rlib",
      "libsmall-1111111111111111.rlib",
    ]);
  });

  it("counts every copy beyond the first across three trees", () => {
    const groups = planDedupe(
      [
        f("/a", "libserde-1111111111111111.rlib", 100, 1),
        f("/b", "libserde-1111111111111111.rlib", 100, 2),
        f("/c", "libserde-1111111111111111.rlib", 100, 3),
      ],
      opts
    );
    expect(reclaimableBytes(groups)).toBe(200);
  });
});
