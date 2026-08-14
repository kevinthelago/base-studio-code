// The graph module system (epic #3604) — the linker that replaced vendoring.
//
// Every piece here is driven with an INJECTED compiler, never esbuild: the real compile is
// browser-only, and the properties worth pinning (what gets compiled, how often, resolution order,
// cycle termination) are all about the link/eval algebra rather than about codegen. The browser check
// is what proves a page still renders; these prove it links.
import { describe, it, expect, beforeEach } from "vitest";
import {
  scanRequires,
  linkGraphModules,
  makeGraphRequire,
  evaluateEntry,
  compileCacheSize,
  __resetCompileCache,
  ENTRY_SPECIFIER,
  type CompileFn,
} from "./graphModules";

/** A fake compiler: emits CJS that records its own requires, and counts how many times it ran. */
function fakeCompiler() {
  const calls: string[] = [];
  const compile: CompileFn = async (source) => {
    calls.push(source);
    return source; // the "source" IS the CJS in these tests — it already contains require() calls
  };
  return { compile, calls };
}

beforeEach(() => __resetCompileCache());

describe("scanRequires", () => {
  it("finds every require specifier, de-duplicated, in first-seen order", () => {
    const cjs = `require("react"); const a = require('@/store'); require("react"); require( "@/components/x" )`;
    expect(scanRequires(cjs)).toEqual(["react", "@/store", "@/components/x"]);
  });

  it("returns nothing for a module with no imports", () => {
    expect(scanRequires("module.exports = {};")).toEqual([]);
  });

  it("does not match a bare word that merely contains 'require'", () => {
    // `prerequire(...)` is not a require call — \\b anchors the match so a substring cannot fake one.
    expect(scanRequires('prerequire("nope")')).toEqual([]);
  });
});

describe("linkGraphModules", () => {
  it("compiles the entry and every graph record it transitively reaches, and NOTHING else", async () => {
    const { compile, calls } = fakeCompiler();
    const graph: Record<string, string> = {
      "@/components/panel": 'require("@/components/leaf"); require("react");',
      "@/components/leaf": 'require("@/store");',
    };
    const { linked } = await linkGraphModules(
      'require("@/components/panel"); require("react");',
      (s) => graph[s] ?? null,
      compile,
    );

    expect([...linked.keys()].sort()).toEqual([ENTRY_SPECIFIER, "@/components/leaf", "@/components/panel"].sort());
    // `react` and `@/store` are NOT records — they stay external for the registry to answer.
    expect(linked.has("react")).toBe(false);
    expect(linked.has("@/store")).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("terminates on an import CYCLE between records", async () => {
    const { compile } = fakeCompiler();
    const graph: Record<string, string> = {
      "@/components/a": 'require("@/components/b");',
      "@/components/b": 'require("@/components/a");',
    };
    const { linked } = await linkGraphModules('require("@/components/a");', (s) => graph[s] ?? null, compile);
    expect([...linked.keys()].sort()).toEqual([ENTRY_SPECIFIER, "@/components/a", "@/components/b"].sort());
  });

  it("with no resolver, links only the entry — every import stays external", async () => {
    const { compile, calls } = fakeCompiler();
    const { linked } = await linkGraphModules('require("@/components/panel");', undefined, compile);
    expect([...linked.keys()]).toEqual([ENTRY_SPECIFIER]);
    expect(calls).toHaveLength(1);
  });

  it("MEMOIZES by exact source: a second link of the same page compiles nothing", async () => {
    const { compile, calls } = fakeCompiler();
    const graph: Record<string, string> = { "@/components/panel": 'require("@/store");' };
    const entry = 'require("@/components/panel");';
    await linkGraphModules(entry, (s) => graph[s] ?? null, compile);
    expect(calls).toHaveLength(2);
    await linkGraphModules(entry, (s) => graph[s] ?? null, compile);
    expect(calls, "a re-mount recompiles nothing — the whole point of the cache").toHaveLength(2);
    expect(compileCacheSize()).toBe(2);
  });

  it("invalidates ONLY the record that changed — its ancestors are not recompiled", async () => {
    const { compile, calls } = fakeCompiler();
    const entry = 'require("@/components/panel");';
    let panel = 'require("@/store"); // v1';
    const resolve = (s: string) => (s === "@/components/panel" ? panel : null);

    await linkGraphModules(entry, resolve, compile);
    expect(calls).toHaveLength(2); // entry + panel

    panel = 'require("@/store"); // v2 — edited';
    await linkGraphModules(entry, resolve, compile);
    // Exactly ONE new compile: the edited panel. The entry's source did not change, so its cached
    // output is reused — under vendoring this was impossible, because the panel was INSIDE the entry's
    // build and editing it invalidated every ancestor.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe(panel);
  });

  it("DECLINES an override that will not compile instead of failing the whole link", async () => {
    // THE Projects-page bug. `graphcomponent` compiled clean standalone and failed when vendored, and
    // because the throw escaped the link phase it took the entire page down — 241 closure members, one
    // broken, and the report was "Build failed with 2 errors" with nothing to point at.
    //
    // A record in the closure is by definition shadowing something the registry can answer, so a bad one
    // must cost its OWN surface and let `require` fall back. Same principle as the unsatisfiable-closure
    // prune, for the other way a record fails.
    const graph: Record<string, string> = {
      "@/components/ok": 'require("@/store");',
      "@/shared/lib/runtime/GraphComponent": "!!! not valid source !!!",
    };
    const compile: CompileFn = async (src) => {
      if (src.startsWith("!!!")) throw new Error("Build failed: unexpected token");
      return src;
    };
    const { linked, failures } = await linkGraphModules(
      'require("@/components/ok"); require("@/shared/lib/runtime/GraphComponent");',
      (s) => graph[s] ?? null,
      compile,
    );
    // The good half linked; the entry survived.
    expect(linked.has(ENTRY_SPECIFIER)).toBe(true);
    expect(linked.has("@/components/ok")).toBe(true);
    // The broken override is absent from the linked set, so `require` falls through to the registry…
    expect(linked.has("@/shared/lib/runtime/GraphComponent")).toBe(false);
    // …and it is NAMED, which is the half that turns the next diagnosis into a read instead of a hunt.
    expect(failures).toEqual([
      { specifier: "@/shared/lib/runtime/GraphComponent", error: expect.stringContaining("Build failed") },
    ]);
  });

  it("still THROWS when the ENTRY itself will not compile", async () => {
    // The entry is the page's own source. There is no fallback for it and nothing to salvage, so the
    // decline above must not quietly swallow a broken page into an empty render.
    const compile: CompileFn = async () => { throw new Error("Build failed: entry is broken"); };
    await expect(linkGraphModules("!!! broken entry !!!", undefined, compile)).rejects.toThrow("entry is broken");
  });
});

describe("makeGraphRequire — resolution order and cycles", () => {
  const linkedOf = (mods: Record<string, string>) =>
    new Map(Object.entries(mods).map(([specifier, cjs]) => [specifier, { specifier, source: cjs, cjs }]));

  it("resolves a graph module BEFORE the app registry — this is what keeps `provides` overrides working (#3660)", () => {
    const appRequire = (s: string) => ({ from: "registry", s });
    const linked = linkedOf({ "@/shared/ui/data/Chip": 'module.exports = { from: "graph" };' });
    const require = makeGraphRequire(linked, appRequire);
    expect(require("@/shared/ui/data/Chip")).toEqual({ from: "graph" });
    // anything the graph does not claim still falls through to the registry
    expect(require("react")).toEqual({ from: "registry", s: "react" });
  });

  it("evaluates each module ONCE per load, however many importers it has", () => {
    let evals = 0;
    (globalThis as unknown as { __count: () => void }).__count = () => { evals += 1; };
    const linked = linkedOf({
      "@/components/shared": 'globalThis.__count(); module.exports = { v: 1 };',
      "@/components/a": 'module.exports = { s: require("@/components/shared") };',
      "@/components/b": 'module.exports = { s: require("@/components/shared") };',
    });
    const require = makeGraphRequire(linked, () => ({}));
    const a = require("@/components/a") as { s: unknown };
    const b = require("@/components/b") as { s: unknown };
    expect(evals).toBe(1);
    expect(a.s, "both importers observe the SAME instance").toBe(b.s);
  });

  it("a cycle terminates: the module record is cached BEFORE its factory runs (Node's rule)", () => {
    const linked = linkedOf({
      "@/components/a": 'exports.name = "a"; exports.b = require("@/components/b");',
      "@/components/b": 'exports.name = "b"; exports.a = require("@/components/a");',
    });
    const require = makeGraphRequire(linked, () => ({}));
    const a = require("@/components/a") as { name: string; b: { name: string; a: unknown } };
    expect(a.name).toBe("a");
    expect(a.b.name).toBe("b");
    // b captured a's exports object mid-construction — the classic CommonJS partial view. It is a real
    // object rather than a hang, which is the property that matters.
    expect(a.b.a).toBeDefined();
  });

  it("propagates the registry's NAMED error for an unregistered specifier — never a silent stub", () => {
    const appRequire = (s: string) => {
      throw new Error(`runtime loader: import "${s}" is not a registered app module.`);
    };
    const require = makeGraphRequire(linkedOf({}), appRequire);
    expect(() => require("@/nope")).toThrow(/not a registered app module/);
  });
});

describe("evaluateEntry", () => {
  it("runs the linked entry and returns its exports", async () => {
    const { compile } = fakeCompiler();
    const graph: Record<string, string> = { "@/components/panel": 'module.exports = { Panel: "P" };' };
    const { linked } = await linkGraphModules(
      'const p = require("@/components/panel"); module.exports = { default: p.Panel };',
      (s) => graph[s] ?? null,
      compile,
    );
    expect(evaluateEntry(linked, () => ({}))).toEqual({ default: "P" });
  });
});
