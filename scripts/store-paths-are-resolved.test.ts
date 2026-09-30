// NO CODE MAY JOIN AN OWNED STORE'S FILENAME ONTO THE BASE DIR.
//
// `epic-every-store-lives-in-the-capability-that-owns-its-noun` moved every global store into the hub of
// the capability that owns its noun, and `bsc_util::store_path_in` is the one mapping. A literal
// `bsc_base_dir().join("perf.db")` names a path nothing writes any more — and because SQLite creates a
// database rather than refusing an absent one, the caller does not fail. It gets a fresh empty store and
// answers from it.
//
// MEASURED 2026-09-30, minutes after a promote: `perf.db`, `skills.db` and `components.db` were all back
// at the install root as freshly seeded stores. The relocation had fixed the CLI — `bsc_util`,
// `bsc-memory`, `data::entity`, `compliance`, `survival`, the run-session cage — and left the DESKTOP APP
// behind, because `src-tauri::platform::paths` and `bsc-component`'s dispatch store keep their own
// resolvers. 463 components sat in `projects/designs/components.db` while the app read 96 of its own, and
// 48 MB of metrics history went unread beside a 56 KB stand-in.
//
// WHY THIS IS A SOURCE CHECK AND NOT A TREE CHECK. `every_root_store_has_an_owner` looks at the install
// root, and it cannot see this: the app recreates the shadow on launch and a sweep archives it later, so
// between gates the tree is clean. The defect is not a file in the wrong place — it is a SECOND SPELLING
// of where a store lives, and only the source shows that.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStore, resolveStorePath } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");

/** The store stems the owner table relocates, read from `bsc_util`'s own table so the two cannot drift. */
type Rec = Record<string, unknown>;
/** The store, typed at the boundary — `loadStore` is a `.mjs` with no declarations, so an untyped
 *  callback parameter is an implicit `any` and `tsc` is right to refuse it. */
function records(): Rec[] {
  return ((loadStore(resolveStorePath(REPO)) as { implementations?: Rec[] }).implementations ?? []);
}

function ownedStems(): string[] {
  const src = records().find((r) => r.id === "bsc-util--lib.rs");
  const code = String(src?.code ?? "");
  const table = code.slice(code.indexOf("pub const STORE_OWNER"), code.indexOf("pub const ROOT_BY_DESIGN"));
  return [...table.matchAll(/\(\s*"([a-z_]+)"\s*,\s*"[a-z-]+"\s*\)/g)].map((m) => m[1]);
}

/** A base-dir receiver on the same expression as the join — what makes a join the BUG rather than fine. */
const BASE_RECEIVERS = ["bsc_base_dir()", "base_dir()"];

describe("a store path is resolved, never spelled", () => {
  it("no record joins an owned store's filename onto the base dir", () => {
    const stems = ownedStems();
    // A guard that found no stems would pass over everything — the failure mode of every store-reading
    // check in this repo.
    expect(stems.length, "the STORE_OWNER table must be readable").toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const rec of records()) {
      const id = String(rec.id ?? "");
      // This file is part of the source it asserts over, and a record's carried tests are fixtures.
      if (id === "bsc-util--tests.rs") continue;
      // PRODUCTION ONLY. A record's `#[cfg(test)]` module builds fixtures on a scratch base, where a
      // literal is correct and matching the resolver would be the bug. The boundary is the first
      // `#[cfg(test)]`, which is where every Rust record in this repo puts its tests.
      const whole = String(rec.code ?? "");
      const cut = whole.indexOf("#[cfg(test)]");
      const code = cut === -1 ? whole : whole.slice(0, cut);
      for (const stem of stems) {
        const needle = `.join("${stem}.db")`;
        let at = code.indexOf(needle);
        while (at !== -1) {
          const lead = code.slice(Math.max(0, at - 140), at);
          const isBase = BASE_RECEIVERS.some((b) => lead.includes(b));
          // A test scratch dir is not the install root.
          const isScratch = /scratch|temp_dir|tmp|TempDir/i.test(lead);
          if (isBase && !isScratch) offenders.push(`${id}: joins "${stem}.db" onto a base dir`);
          at = code.indexOf(needle, at + 1);
        }
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      "a store's filename is joined onto the base dir, so this reads a path the owner table has moved — " +
        "resolve it with `bsc_util::store_path_in`",
    ).toEqual([]);
  });

  it("and the one mapping is still where the guard expects it", () => {
    // If `STORE_OWNER` is renamed or moved, `ownedStems` silently returns [] and the test above passes
    // over everything. This is what makes that impossible to do quietly.
    const src = readFileSync(resolve(REPO, "scripts/store-paths-are-resolved.test.ts"), "utf8");
    expect(src).toContain("pub const STORE_OWNER");
    expect(ownedStems()).toContain("perf");
    expect(ownedStems()).toContain("skills");
    expect(ownedStems()).toContain("components");
  });
});
