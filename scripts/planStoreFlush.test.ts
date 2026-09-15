// A LANED PLAN WRITE IS FLUSHED EXPLICITLY (`a-laned-plan-write-is-flushed-explicitly`).
//
// A write to a plan store on lanes lands in its table and a TEMP `lane_dirty` note; only `Overlay::flush`
// turns that note into a revision in `row_revs`. `Drop for Store` flushes too, but `std::process::exit` and an
// abort never run destructors — so a write that relied on Drop was lost exactly when a process ended early.
// Every write method now journals before it returns. Two things can quietly undo that, and neither is
// visible at run time from a test that happens to drop its store:
//
//   1. a new `impl Store` method that writes SQL and returns without flushing;
//   2. a process that calls `std::process::exit` while a plan store it wrote is still alive.
//
// Both are read from the committed record store, the source the crates compile from.
import { describe, it, expect } from "vitest";
import { loadStore } from "./lib/recordStore.mjs";

type Rec = { id: string; code?: string };
const records = (loadStore().implementations as Rec[]).filter((r) => typeof r.code === "string");

/** `src` with string literals, char literals and comments blanked to spaces, so braces and tokens in them never count. */
function blank(src: string): string {
  const out = src.split("");
  let i = 0;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      wipe(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === "r" && /^r#*"/.test(src.slice(i, i + 8)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1];
      const end = src.indexOf(`"${hashes}`, i + hashes.length + 2);
      const stop = end === -1 ? src.length : end + hashes.length + 1;
      wipe(i, stop);
      i = stop;
    } else if (c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== '"') k += src[k] === "\\" ? 2 : 1;
      wipe(i, k + 1);
      i = k + 1;
    } else if (c === "'" && /^'(\\.|[^\\'])'/.test(src.slice(i, i + 4))) {
      const len = src[i + 1] === "\\" ? 4 : 3;
      wipe(i, i + len);
      i += len;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** The body (between its braces) of every `fn name(&self ...)` inside an `impl Store {` block, tests excluded. */
function storeMethods(code: string): { name: string; body: string }[] {
  const src = blank(code.split(/#\[cfg\(test\)\]\s*mod tests/)[0]);
  const methods: { name: string; body: string }[] = [];
  const close = (open: number) => {
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) return k;
    }
    return src.length;
  };
  for (const impl of src.matchAll(/\bimpl\s+Store\s*\{/g)) {
    const open = impl.index! + impl[0].length - 1;
    const block = src.slice(open, close(open) + 1);
    for (const fn of block.matchAll(/\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(\s*&(?:mut\s+)?self\b/g)) {
      const start = block.indexOf("{", fn.index!);
      methods.push({ name: fn[1], body: block.slice(start, close(open + start) - open + 1) });
    }
  }
  return methods;
}

const WRITE = /\.execute(?:_batch)?\s*\(|\bdelete_by\s*\(|\bclear_tables\s*\(/g;
const FLUSH = /\bself\.lanes_flushed\s*\(|\bself\.flush_lanes\s*\(|\bself\.lanes\.blob_set\s*\(/g;

/** Writes that are right to skip the journal, and why. A name here that stops writing must be removed. */
const EXEMPT: Record<string, string> = {
  fleet_session_upsert: "fleet_sessions stays on main by design: no lane triggers watch it",
  fleet_session_heartbeat: "fleet_sessions stays on main by design: no lane triggers watch it",
  fleet_session_set_status: "fleet_sessions stays on main by design: no lane triggers watch it",
  fleet_session_remove: "fleet_sessions stays on main by design: no lane triggers watch it",
  fleet_write_record: "fleet_writes is main-only audit, not a laned table",
  // `bsc-plan-claim-takes-an-issue-atomically`: a claim is live coordination between concurrent sessions, so
  // `issue_claims` is unlaned exactly like `fleet_sessions` — every lane must see one claim at once.
  in_claim_transaction: "issue_claims stays on main by design: BEGIN IMMEDIATE / COMMIT around an unlaned write",
  insert_claim: "issue_claims stays on main by design: no lane triggers watch it",
  unclaim_issue: "issue_claims stays on main by design: no lane triggers watch it",
  drop_issue_claim: "issue_claims stays on main by design: no lane triggers watch it",
  clear_issue_claims: "issue_claims stays on main by design: no lane triggers watch it",
};

const lastIndex = (body: string, re: RegExp) => Math.max(-1, ...[...body.matchAll(re)].map((m) => m.index!));

describe("a plan-store write journals its lane before it returns", () => {
  const plandb = records.filter((r) => r.id.startsWith("plandb--") && !r.id.startsWith("plandb--cli"));
  const methods = plandb.flatMap((r) => storeMethods(r.code!).map((m) => ({ ...m, id: r.id })));

  it("reads the plan store's methods from the record store", () => {
    expect(methods.map((m) => m.name)).toEqual(expect.arrayContaining(["upsert", "feature_upsert", "surface_upsert", "blob_set"]));
    expect(methods.length).toBeGreaterThan(80);
  });

  it("every method that writes SQL flushes after its last write, directly or through a method that does", () => {
    // A method flushes if its body calls a flush, or calls a self method that flushes (to a fixpoint).
    const flushing = new Set(methods.filter((m) => lastIndex(m.body, FLUSH) >= 0).map((m) => m.name));
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of methods) {
        if (flushing.has(m.name)) continue;
        if ([...m.body.matchAll(/\bself\.([a-z_][a-z0-9_]*)\s*\(/g)].some((c) => flushing.has(c[1]))) {
          flushing.add(m.name);
          grew = true;
        }
      }
    }
    const offenders = methods
      .filter((m) => !(m.name in EXEMPT) && lastIndex(m.body, WRITE) >= 0)
      .filter((m) => {
        const flushAt = Math.max(
          lastIndex(m.body, FLUSH),
          ...[...m.body.matchAll(/\bself\.([a-z_][a-z0-9_]*)\s*\(/g)].filter((c) => flushing.has(c[1])).map((c) => c.index!),
        );
        return flushAt < lastIndex(m.body, WRITE);
      })
      .map((m) => `${m.id} :: ${m.name}`);
    expect(offenders, "these write and return without journaling — end them with self.lanes_flushed(..) / self.flush_lanes()").toEqual([]);
  });

  it("every exemption still names a method that writes", () => {
    const writers = new Set(methods.filter((m) => lastIndex(m.body, WRITE) >= 0).map((m) => m.name));
    expect(Object.keys(EXEMPT).filter((n) => !writers.has(n))).toEqual([]);
  });
});

// THE RELATIONAL STORES ON LANES (`the-relational-stores-are-laned`) hold the same rule through `bsc-lane-rows`: a
// `Store` method ends with `self.lanes_flushed(..)`, and a store whose writes are free functions over a connection
// (atlas, projects) ends each one with `LANES.flush(conn)`.

/** The body of every `fn` in `code` — method or free function — outside its test module. */
function allFns(code: string): { name: string; body: string }[] {
  const src = blank(code.split(/#\[cfg\(test\)\]\s*mod tests/)[0]);
  const fns: { name: string; body: string }[] = [];
  for (const fn of src.matchAll(/\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = src.indexOf("{", fn.index!);
    const semi = src.indexOf(";", fn.index!);
    if (open === -1 || (semi !== -1 && semi < open)) continue;
    let depth = 0;
    let end = src.length;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) {
        end = k;
        break;
      }
    }
    fns.push({ name: fn[1], body: src.slice(open, end + 1) });
  }
  return fns;
}

const RELATIONAL_RECORDS = ["bsc-request--lib.rs", "bsc-loop--lib.rs", "skilldb--lib.rs", "atlasdb--lib.rs", "bsc-project--store.rs"];
const RELATIONAL_FLUSH = /\bself\.lanes_flushed\s*\(|\bself\.flush_lanes\s*\(|\bLANES\.flush\s*\(/g;

/** Writes that are right to skip the journal, and why, as `<record>::<fn>`. A name here that stops writing must go. */
const RELATIONAL_EXEMPT: Record<string, string> = {
  "atlasdb--lib.rs::migrate": "schema on open, before the lane binds",
  "atlasdb--lib.rs::seed_synthesis": "runs only inside seed, which flushes before its transaction commits",
  "bsc-project--store.rs::ensure_schema": "schema on open, before the lane binds",
  "bsc-project--store.rs::add_column_if_missing": "schema on open, before the lane binds",
};

describe("a relational-store write journals its lane before it returns", () => {
  const fns = RELATIONAL_RECORDS.flatMap((id) => {
    const rec = records.find((r) => r.id === id);
    return rec ? allFns(rec.code!).map((f) => ({ ...f, id, key: `${id}::${f.name}` })) : [];
  });

  it("reads every relational store's write paths from the record store", () => {
    expect(new Set(fns.map((f) => f.id))).toEqual(new Set(RELATIONAL_RECORDS));
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(["add_note", "claim", "say", "group_toggle_member", "seed", "set_state"]));
  });

  it("every fn that writes SQL flushes after its last write, directly or through a fn of its record that does", () => {
    const calls = (f: (typeof fns)[number]) =>
      [...f.body.matchAll(/\b(?:self\.)?([a-z_][a-z0-9_]*)\s*\(/g)].map((c) => ({ key: `${f.id}::${c[1]}`, at: c.index! }));
    const flushing = new Set(fns.filter((f) => lastIndex(f.body, RELATIONAL_FLUSH) >= 0).map((f) => f.key));
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of fns) {
        if (!flushing.has(f.key) && calls(f).some((c) => c.key !== f.key && flushing.has(c.key))) {
          flushing.add(f.key);
          grew = true;
        }
      }
    }
    const offenders = fns
      .filter((f) => !(f.key in RELATIONAL_EXEMPT) && lastIndex(f.body, WRITE) >= 0)
      .filter((f) => {
        const flushAt = Math.max(
          lastIndex(f.body, RELATIONAL_FLUSH),
          ...calls(f).filter((c) => c.key !== f.key && flushing.has(c.key)).map((c) => c.at),
        );
        return flushAt < lastIndex(f.body, WRITE);
      })
      .map((f) => f.key);
    expect(offenders, "these write and return without journaling — end them with self.lanes_flushed(..) / LANES.flush(conn)").toEqual([]);
  });

  it("every exemption still names a fn that writes", () => {
    const writers = new Set(fns.filter((f) => lastIndex(f.body, WRITE) >= 0).map((f) => f.key));
    expect(Object.keys(RELATIONAL_EXEMPT).filter((k) => !writers.has(k))).toEqual([]);
  });
});

/** A record's module path as other code names it: `bsc--defer--mod.rs` is `defer` in crate `bsc`. */
function modulePath(id: string): { krate: string; path: string } {
  const [krate, ...rest] = id.replace(/\.rs$/, "").split("--");
  const parts = rest.filter((p, i) => !(p === "mod" && i === rest.length - 1) && !(p === "lib" && rest.length === 1));
  return { krate: krate.replace(/-/g, "_"), path: parts.map((p) => p.replace(/-/g, "_")).join("::") };
}

/** Exits a plan-store opener is allowed, each with the reason it cannot strand a write. */
const EXIT_ALLOWED: Record<string, string> = {
  "bsc--superseded.rs": "opens the plan store read-only in a scope that has ended before it exits",
  "bsc--hook--mod.rs": "exits only in bash-deny and bash-supply, which open no plan store; the defer hook it dispatches only reads",
};

describe("no process exits while a plan store it wrote can be alive", () => {
  const code = (r: Rec) => blank(r.code!);
  const openers = records.filter((r) => /\bplandb::(Store|open)|\buse plandb\b/.test(code(r)));

  it("finds the plan-store openers", () => {
    expect(openers.map((r) => r.id)).toEqual(expect.arrayContaining(["bsc--defer--mod.rs", "bsc-fleet--cli.rs", "bsc-work--cli.rs"]));
  });

  it("a record that calls process::exit neither opens a plan store nor calls a module that does, unless allowed with a reason", () => {
    const reaches = (r: Rec) => {
      const src = code(r);
      const own = modulePath(r.id).krate;
      return openers.some((o) => {
        if (o.id === r.id) return true;
        const { krate, path } = modulePath(o.id);
        if (!path) return new RegExp(`\\b${krate}::`).test(src) && krate !== own;
        const named = krate === own ? `crate::${path}` : `${krate}::${path}`;
        return new RegExp(`\\b${named}\\b`).test(src);
      });
    };
    const exiting = records.filter((r) => /\bprocess::exit\s*\(/.test(code(r)));
    const unsafe = exiting.filter((r) => reaches(r) && !(r.id in EXIT_ALLOWED)).map((r) => r.id);
    expect(unsafe, "flush (or drop) every plan store before exiting, then allow the record here with the reason").toEqual([]);
    const stale = Object.keys(EXIT_ALLOWED).filter((id) => !exiting.some((r) => r.id === id && reaches(r)));
    expect(stale, "an allowance whose record no longer exits into a plan store must be removed").toEqual([]);
  });
});
