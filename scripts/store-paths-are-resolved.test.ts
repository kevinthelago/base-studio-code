// NO CODE MAY SPELL AN OWNED STORE'S LOCATION. IT RESOLVES IT THROUGH THE OWNER TABLE.
//
// `epic-every-store-lives-in-the-capability-that-owns-its-noun` moved every global store into the hub of
// the capability that owns its noun, and `bsc_util::{store_path_in, json_store_dir_in}` is the one
// mapping. A join that spells the old location names a path nothing writes any more — and neither backend
// refuses it. SQLite CREATES a database rather than erroring, and an absent json-store LISTS EMPTY. So
// the caller does not fail; it answers from nothing.
//
// MEASURED 2026-09-30, minutes after a promote: `perf.db`, `skills.db` and `components.db` were all back
// at the install root as freshly seeded stores. The relocation had fixed the CLI and left the DESKTOP APP
// behind, because `src-tauri::platform::paths` and `bsc-component`'s dispatch store keep their own
// resolvers. 463 components sat in `projects/designs/components.db` while the app read 96 of its own.
//
// MEASURED AGAIN THE SAME DAY, and this is why the guard below is shaped the way it is: the version of
// this file that caught the app missed TWELVE more sites, and `bsc components list` shipped printing `[]`
// against those same 463 records. Both misses were in the guard, not in the census:
//
//   1. It cut each record at the FIRST `#[cfg(test)]`, on a stated premise — "which is where every Rust
//      record in this repo puts its tests" — that is simply false. `bsc-component--cli.rs` interleaves
//      test modules through 740 KB of source, and `open_component_store`, the real defect, sits AFTER one.
//      Test modules are now stripped by BRACE MATCHING, so production code after one is still read.
//   2. It looked for `.join("<stem>.db")` only. A json-store is addressed by its DIRECTORY, whose sibling
//      `<dir>.db` is the database, so the live spelling was `.join("components")` — and more often
//      `.join(SPEC.dir_segment)`, an indirection through a `CliSpec` constant that no literal search can
//      see. All three spellings are checked now.
//
// WHY THIS IS A SOURCE CHECK AND NOT A TREE CHECK. `every_root_store_has_an_owner` looks at the install
// root, and it cannot see this: the app recreates a shadow on launch and a sweep archives it later, so
// between gates the tree is clean. Worse, the json-store half leaves NO trace at all — it reads a missing
// db as empty without creating one. The defect is not a file in the wrong place, it is a SECOND SPELLING
// of where a store lives, and only the source shows that.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStore, resolveStorePath } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");

type Rec = Record<string, unknown>;
/** The store, typed at the boundary — `loadStore` is a `.mjs` with no declarations, so an untyped
 *  callback parameter is an implicit `any` and `tsc` is right to refuse it. */
function records(): Rec[] {
  return (loadStore(resolveStorePath(REPO)) as { implementations?: Rec[] }).implementations ?? [];
}

/** The store stems the owner table relocates, read from `bsc_util`'s own table so the two cannot drift. */
function ownedStems(): string[] {
  const src = records().find((r) => r.id === "bsc-util--lib.rs");
  const code = String(src?.code ?? "");
  const table = code.slice(code.indexOf("pub const STORE_OWNER"), code.indexOf("pub const ROOT_BY_DESIGN"));
  return [...table.matchAll(/\(\s*"([a-z_]+)"\s*,\s*"[a-z-]+"\s*\)/g)].map((m) => m[1]);
}

/**
 * `code` with every `#[cfg(test)]` module removed, by MATCHING BRACES rather than cutting at the first
 * one. A record's tests build fixtures on a scratch base, where a literal path is correct and resolving
 * it would be the bug — but a large record interleaves test modules with production code, so "everything
 * after the first one" throws most of the file away. That is the miss this function exists to prevent.
 */
function productionOnly(code: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const m = /#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/.exec(code.slice(i));
    if (!m) {
      out.push(code.slice(i));
      return out.join("");
    }
    out.push(code.slice(i, i + m.index));
    let b = i + m.index + m[0].length;
    for (let depth = 1; b < code.length && depth > 0; b += 1) {
      if (code[b] === "{") depth += 1;
      else if (code[b] === "}") depth -= 1;
    }
    i = b;
  }
}

/**
 * Every `CliSpec` const in `code`, as its name → the store segment it names.
 *
 * A `dir_segment` is reached through a named constant far more often than spelled at the join, so a guard
 * that only reads literals sees almost none of the real sites. Resolving BY SPEC NAME is what keeps the
 * report precise: `bsc-component--cli.rs` declares both `COMPONENT_SPEC` (`components`, owned) and
 * `KIT_SPEC` (`kits`, not owned), and a record-wide union would accuse the innocent one too.
 */
function specSegments(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/const\s+(\w+)\s*:\s*[\w:]*CliSpec\s*=\s*[\w:]*CliSpec\s*\{/g)) {
    const body = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1200);
    const lit = /dir_segment:\s*"([a-z_]+)"/.exec(body);
    if (lit) out.set(m[1], lit[1]);
    else if (/dir_segment:\s*[\w:]*STORE_SEGMENT/.test(body)) out.set(m[1], "@STORE_SEGMENT");
  }
  return out;
}

/** Every `STORE_SEGMENT` constant in the store, by the stem it holds. One declaration exists today. */
function storeSegments(recs: Rec[]): string[] {
  const out = new Set<string>();
  for (const r of recs) {
    for (const m of String(r.code ?? "").matchAll(/STORE_SEGMENT\s*:\s*&(?:'static\s+)?str\s*=\s*"([a-z_]+)"/g)) {
      out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * The store stem a join argument names, or null when it cannot be known statically.
 *
 * NULL IS NOT "FINE" — it is the guard's honest limit. `bsc-json-store`'s `Store::new`, `bsc-mcp` and one
 * `bsc-ui` site take the segment as a RUNTIME PARAMETER, so no source check can say which store they
 * open. Those three are written to resolve through `json_store_dir_in` unconditionally instead, which is
 * a no-op for an unowned noun and correct for every input — the fix does not depend on this test seeing
 * them, because it cannot.
 */
function resolveSegment(arg: string, specStem: Map<string, string>, storeSegment: string[]): string | null {
  if (/STORE_SEGMENT/.test(arg)) return storeSegment.find((s) => s) ?? null;
  const viaSpec = /^(\w+)\.dir_segment$/.exec(arg.trim());
  if (viaSpec) {
    const stem = specStem.get(viaSpec[1]);
    if (stem === "@STORE_SEGMENT") return storeSegment.find((s) => s) ?? null;
    return stem ?? null;
  }
  return null;
}

/** A base-dir receiver on the same expression as the join — what makes a join the BUG rather than fine. */
const BASE_RECEIVERS = ["bsc_base_dir()", "base_dir()"];
/** Resolving through the owner table. Any of these on the expression means the site is already correct. */
const RESOLVERS = ["json_store_dir_in", "store_path_in", "log_dir_in", "projects_root_in", "store_owner"];

describe("a store path is resolved, never spelled", () => {
  it("no record spells an owned store's location onto the base dir", () => {
    const stems = ownedStems();
    // A guard that found no stems would pass over everything — the failure mode of every store-reading
    // check in this repo.
    expect(stems.length, "the STORE_OWNER table must be readable").toBeGreaterThan(10);
    const owned = new Set(stems);
    const storeSegment = storeSegments(records());

    const offenders: string[] = [];
    for (const rec of records()) {
      const id = String(rec.id ?? "");
      // These two are part of the source they assert over, and a record's carried tests are fixtures.
      if (id === "bsc-util--tests.rs" || id === "bsc-util--lib.rs") continue;
      const code = productionOnly(String(rec.code ?? ""));

      // A `CliSpec` const in THIS record, by name, so `COMPONENT_SPEC.dir_segment` resolves to the one
      // stem it actually names rather than to every segment the record happens to mention.
      const specStem = specSegments(code);

      for (const m of code.matchAll(/\.join\(\s*([^()]{0,60}?)\s*\)/g)) {
        const arg = m[1];
        const at = m.index ?? 0;
        const lead = code.slice(Math.max(0, at - 340), at);
        if (!BASE_RECEIVERS.some((b) => lead.includes(b))) continue;
        // Already resolved through the owner table.
        if (RESOLVERS.some((r) => lead.includes(r) || arg.includes(r))) continue;
        // A test scratch dir is not the install root.
        if (/scratch|temp_dir|tmp|TempDir/i.test(lead)) continue;
        // THE LEGACY SPELLING IS CORRECT WHERE IT IS THE MIGRATION'S INPUT. `migrate_legacy_store` is
        // handed the path a store USED to live at; resolving that argument would ask it to migrate the
        // new path onto itself. `bsc-survival--store.rs` and `compliance--store.rs` are both this shape.
        const ctx = code.slice(Math.max(0, at - 400), at + 200);
        if (/migrate_legacy_store|legacy/i.test(ctx)) continue;

        const literal = /^"([a-z_]+)(\.db)?"$/.exec(arg);
        if (literal && owned.has(literal[1])) {
          offenders.push(`${id}: joins ${arg} onto a base dir`);
          continue;
        }
        const stem = resolveSegment(arg, specStem, storeSegment);
        if (stem && owned.has(stem)) {
          offenders.push(`${id}: joins ${arg} (the owned segment "${stem}") onto a base dir`);
        }
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      "an owned store's location is spelled onto the base dir, so this reads a path the owner table has " +
        "moved. A SQLite store is silently created there; a json-store silently lists empty. Resolve it " +
        "with `bsc_util::store_path_in` (a .db) or `bsc_util::json_store_dir_in` (a json-store dir).",
    ).toEqual([]);
  });

  it("and the one mapping is still where the guard expects it", () => {
    // If `STORE_OWNER` is renamed or moved, `ownedStems` silently returns [] and the test above passes
    // over everything. This is what makes that impossible to do quietly.
    const src = readFileSync(resolve(REPO, "scripts/store-paths-are-resolved.test.ts"), "utf8");
    expect(src).toContain("pub const STORE_OWNER");
    for (const stem of ["perf", "skills", "components", "personas", "secrets"]) {
      expect(ownedStems()).toContain(stem);
    }
  });

  it("strips a test module by braces, so production code after one is still read", () => {
    // The blind spot that let twelve sites through. A record shaped like `bsc-component--cli.rs` —
    // production, a test module, then MORE production — must come back with both production halves.
    const code = [
      'fn first() { base.join("before"); }',
      "#[cfg(test)]",
      "mod tests {",
      '    fn inner() { if x { scratch.join("personas.db"); } }',
      "}",
      'fn second() { base.join("after"); }',
    ].join("\n");
    const prod = productionOnly(code);
    expect(prod, "the production code BEFORE the test module survives").toContain('join("before")');
    expect(prod, "and the production code AFTER it — the miss this exists to prevent").toContain('join("after")');
    expect(prod, "while the test module's own body is gone").not.toContain("personas.db");
  });
});
