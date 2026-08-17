import { describe, expect, it } from "vitest";
import { groupUnits, parseUnitFile } from "./target-units.mjs";

describe("parseUnitFile", () => {
  it("splits a hashed artifact into its name-part and metadata hash", () => {
    expect(parseUnitFile("libbsc_graph-1a2b3c4d5e6f7890.rlib")).toEqual({
      namePart: "libbsc_graph",
      hash: "1a2b3c4d5e6f7890",
    });
    expect(parseUnitFile("bsc_graph-1a2b3c4d5e6f7890.d")).toEqual({
      namePart: "bsc_graph",
      hash: "1a2b3c4d5e6f7890",
    });
  });

  it("returns null for the un-hashed copies cargo also writes", () => {
    // `target/debug/bsc.exe` and `base_studio_code.pdb` are the names a human or another tool
    // reaches for. Sweeping them would break `$BSC_BIN` resolution, so they must not parse.
    for (const name of ["bsc.exe", "base_studio_code.pdb", "libbsc_graph.rlib", "CACHEDIR.TAG"]) {
      expect(parseUnitFile(name), name).toBeNull();
    }
  });

  it("rejects a suffix that is not exactly 16 hex chars", () => {
    expect(parseUnitFile("bsc_graph-1a2b3c4d5e6f789.rlib")).toBeNull(); // 15
    expect(parseUnitFile("bsc_graph-zzzzzzzzzzzzzzzz.rlib")).toBeNull(); // not hex
  });
});

describe("groupUnits", () => {
  const mt = (name: string, mtimeMs: number) => ({ name, mtimeMs });

  it("groups one compilation's file family under a single key", () => {
    const units = groupUnits([
      mt("libbsc_graph-1a2b3c4d5e6f7890.rlib", 100),
      mt("bsc_graph-1a2b3c4d5e6f7890.rmeta", 90),
      mt("bsc_graph-1a2b3c4d5e6f7890.d", 80),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe("bsc_graph-1a2b3c4d5e6f7890");
    expect(units[0].files).toHaveLength(3);
  });

  /** The case that makes "strip a leading lib" wrong: a crate whose name really starts with `lib`.
   *  Stripping yields `libduckdb_sys` from the .rlib but `duckdb_sys` from the .d — two names for
   *  one unit, which would split it across planPrune groups and let half of it be deleted. */
  it("takes the SHORTEST name-part, so libduckdb-sys stays one unit", () => {
    const units = groupUnits([
      mt("liblibduckdb_sys-aaaaaaaaaaaaaaaa.rlib", 100),
      mt("libduckdb_sys-aaaaaaaaaaaaaaaa.d", 100),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].crate).toBe("libduckdb_sys");
    expect(units[0].files).toHaveLength(2);
  });

  it("keeps distinct hashes as distinct units whose keys parse back for planPrune", async () => {
    const units = groupUnits([
      mt("libbsc_graph-1111111111111111.rlib", 100),
      mt("bsc_graph-1111111111111111.d", 100),
      mt("libbsc_graph-2222222222222222.rlib", 200),
      mt("bsc_graph-2222222222222222.d", 200),
    ]);
    expect(units).toHaveLength(2);
    const { crateNameOf } = await import("./incremental-prune-plan.mjs");
    for (const u of units) expect(crateNameOf(u.key)).toBe("bsc_graph");
  });

  /** The crate name is derived from the files a unit ACTUALLY has, so a family with no un-prefixed
   *  member keeps the `lib` prefix. Real units always emit a `.d` alongside the rlib, so this is a
   *  degenerate input rather than a live case — pinned because the consequence is worth knowing:
   *  it only changes which planPrune GROUP the unit lands in, i.e. how much gets reclaimed. A split
   *  group keeps `keep` survivors on each side, which errs toward keeping more. Never toward
   *  deleting a unit's files inconsistently, because the family is keyed on the hash, not the name. */
  it("falls back to the prefixed name when a unit has no un-prefixed file", () => {
    const units = groupUnits([mt("libbsc_graph-1111111111111111.rlib", 100)]);
    expect(units[0].crate).toBe("libbsc_graph");
    expect(units[0].files).toEqual(["libbsc_graph-1111111111111111.rlib"]);
  });

  it("uses the NEWEST file as the unit's mtime", () => {
    // The oldest would let one stale `.d` drag a live unit under the age floor and get it swept.
    const units = groupUnits([
      mt("libbsc_graph-1a2b3c4d5e6f7890.rlib", 500),
      mt("bsc_graph-1a2b3c4d5e6f7890.d", 100),
    ]);
    expect(units[0].mtimeMs).toBe(500);
  });

  it("omits unrecognized files entirely, so the caller can never delete them", () => {
    expect(groupUnits([mt("bsc.exe", 100), mt("CACHEDIR.TAG", 100)])).toEqual([]);
  });
});
