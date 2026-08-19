// The link verifier, driven with an INJECTED compiler and registry — no esbuild, no store. What is
// pinned here is the judgement (what counts as resolved, what a compile failure does to a sweep), not
// codegen; the browser check is what proves it against the real packaged records.
import { describe, it, expect, beforeEach } from "vitest";
import { verifyGraphRecord, describeVerdict } from "@/shared/lib/runtime/verifyRecord";
import { __resetCompileCache, type CompileFn } from "./graphModules";

/** The fake compiler treats the source AS the CJS — it already contains `require()` calls. */
const compile: CompileFn = async (source) => {
  if (source.includes("@@SYNTAX_ERROR@@")) throw new Error("Unexpected token");
  return source;
};

const registry = (...specs: string[]) => (s: string) => specs.includes(s);

beforeEach(() => __resetCompileCache());

describe("verifyGraphRecord", () => {
  it("passes when every specifier is a registered platform module", async () => {
    const v = await verifyGraphRecord('require("react"); require("@/store");', {
      isRegistered: registry("react", "@/store"),
      compile,
    });
    expect(v.ok).toBe(true);
    expect(v.unresolved).toEqual([]);
    expect(v.imports).toEqual(["@/store", "react"]);
    expect(v.linkedCount).toBe(1);
  });

  it("names every specifier that resolves to nothing — these are what throw at mount", async () => {
    const v = await verifyGraphRecord('require("react"); require("@/nope"); require("@/also-nope");', {
      isRegistered: registry("react"),
      compile,
    });
    expect(v.ok).toBe(false);
    expect(v.unresolved).toEqual(["@/also-nope", "@/nope"]); // sorted, so a message is stable
  });

  it("counts a SIBLING record as resolved, and follows it transitively", async () => {
    const graph: Record<string, string> = {
      "@/components/panel": 'require("react"); require("@/components/leaf");',
      "@/components/leaf": 'require("@/store");',
    };
    const v = await verifyGraphRecord('require("@/components/panel");', {
      resolveSource: (s) => graph[s] ?? null,
      isRegistered: registry("react", "@/store"),
      compile,
    });
    expect(v.ok).toBe(true);
    expect(v.linkedCount).toBe(3); // entry + panel + leaf
  });

  it("counts a `provides` OVERRIDE as resolved — a record answering a platform specifier is legitimate (#3660)", async () => {
    // The registry does NOT know this specifier; only the graph does. Under a registry-only check this
    // would read as unresolved, which is the false alarm that makes a guard untrustworthy.
    const v = await verifyGraphRecord('require("@/shared/ui/data/Chip");', {
      resolveSource: (s) => (s === "@/shared/ui/data/Chip" ? "module.exports = {};" : null),
      isRegistered: registry(),
      compile,
    });
    expect(v.ok).toBe(true);
  });

  it("checks a BARE npm specifier too (#4224) — the loader's require demands every specifier be registered", async () => {
    const bad = await verifyGraphRecord('require("zustand/react/shallow");', { isRegistered: registry(), compile });
    expect(bad.ok, "an unregistered bare specifier is exactly what sailed past the regex guard").toBe(false);
    expect(bad.unresolved).toEqual(["zustand/react/shallow"]);
    const good = await verifyGraphRecord('require("zustand/react/shallow");', {
      isRegistered: registry("zustand/react/shallow"),
      compile,
    });
    expect(good.ok).toBe(true);
  });

  it("REPORTS a compile failure instead of throwing — a sweep must not stop at the first bad record", async () => {
    const v = await verifyGraphRecord("@@SYNTAX_ERROR@@", { isRegistered: registry(), compile });
    expect(v.ok).toBe(false);
    expect(v.compileError).toMatch(/Unexpected token/);
    expect(v.unresolved, "nothing can be unresolved when nothing compiled").toEqual([]);
    expect(v.linkedCount).toBe(0);
  });

  it("does NOT evaluate the record — no module-init side effects run", async () => {
    let ran = false;
    (globalThis as unknown as { __sideEffect: () => void }).__sideEffect = () => { ran = true; };
    const v = await verifyGraphRecord('globalThis.__sideEffect(); require("react");', {
      isRegistered: registry("react"),
      compile,
    });
    expect(v.ok).toBe(true);
    expect(ran, "verification must be side-effect free — a Studio verifying on keystroke would re-run registries").toBe(false);
  });

  it("reports an unresolved import inside a TRANSITIVELY linked record, not just the entry", async () => {
    const graph: Record<string, string> = { "@/components/panel": 'require("@/missing-dep");' };
    const v = await verifyGraphRecord('require("@/components/panel");', {
      resolveSource: (s) => graph[s] ?? null,
      isRegistered: registry(),
      compile,
    });
    expect(v.ok).toBe(false);
    expect(v.unresolved).toEqual(["@/missing-dep"]);
  });
});

describe("describeVerdict", () => {
  it("says which of the three things happened", async () => {
    const ok = await verifyGraphRecord('require("react");', { isRegistered: registry("react"), compile });
    expect(describeVerdict("x", ok)).toBe("x: ok (1 module(s), 1 import(s))");

    const unresolved = await verifyGraphRecord('require("@/nope");', { isRegistered: registry(), compile });
    expect(describeVerdict("x", unresolved)).toBe("x: 1 unresolved import(s) — @/nope");

    const broken = await verifyGraphRecord("@@SYNTAX_ERROR@@", { isRegistered: registry(), compile });
    expect(describeVerdict("x", broken)).toMatch(/^x: does not compile — /);
  });
});
