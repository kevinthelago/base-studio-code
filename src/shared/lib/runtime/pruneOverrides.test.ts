// #an-incomplete-override-falls-back-instead-of-killing-the-page — declining an override that cannot
// stand up.
//
// The rule under test is a trade between two bad outcomes, and the tests are written to pin WHICH one it
// picks in each case:
//   · a broken override that still wins  ⇒ every page touching that specifier dies (the reported bug)
//   · an override declined too eagerly   ⇒ a working graph migration silently reverts to bundled code
// So: decline only when the closure genuinely cannot resolve AND the platform has something to answer
// with. Everything else is left exactly as the linker produced it.
import { describe, it, expect } from "vitest";
import { pruneUnsatisfiableOverrides, ENTRY_SPECIFIER, type LinkedModule } from "@/shared/lib/runtime/graphModules";

/** A linked module whose compiled CJS requires `deps` — the shape `scanRequires` reads. */
const mod = (specifier: string, deps: string[] = []): LinkedModule => ({
  specifier,
  source: "",
  cjs: deps.map((d) => `require("${d}");`).join("\n") || "module.exports = {};",
});

const linkOf = (...mods: LinkedModule[]) => new Map(mods.map((m) => [m.specifier, m]));
/** The platform registry for a test: these specifiers resolve to real bundled modules. */
const registry = (...specs: string[]) => (s: string) => specs.includes(s);

describe("pruneUnsatisfiableOverrides", () => {
  it("declines an override whose closure reaches nothing, naming what was missing", () => {
    // The REPORTED case: an impl provides `usePageTabs`, its code imports `arrayMove`, and nothing
    // anywhere can answer `arrayMove`. Before this, that killed every page importing usePageTabs.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/shared/hooks/usePageTabs"]),
      mod("@/shared/hooks/usePageTabs", ["@/shared/lib/core/arrayMove"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/shared/hooks/usePageTabs"));

    expect(kept.has("@/shared/hooks/usePageTabs")).toBe(false);
    expect(declined).toEqual([{ specifier: "@/shared/hooks/usePageTabs", missing: "@/shared/lib/core/arrayMove" }]);
    // The entry survives — dropping the override is precisely what lets it evaluate.
    expect(kept.has(ENTRY_SPECIFIER)).toBe(true);
  });

  it("declines the Console case too — the bug was never Glance-specific", () => {
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/shared/lib/fleet/coordination"]),
      mod("@/shared/lib/fleet/coordination", ["@/shared/lib/fleet/coordinationDeadlock"]),
    );
    const { declined } = pruneUnsatisfiableOverrides(linked, registry("@/shared/lib/fleet/coordination"));
    expect(declined.map((d) => d.missing)).toEqual(["@/shared/lib/fleet/coordinationDeadlock"]);
  });

  it("KEEPS a healthy override — graph-first (#3660) still wins when the record can stand alone", () => {
    // The half that must not regress: a record that provides a module and resolves its own imports is
    // still the one that renders.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/shared/ui/controls/Button"]),
      mod("@/shared/ui/controls/Button", ["react"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/shared/ui/controls/Button", "react"));
    expect(kept.has("@/shared/ui/controls/Button")).toBe(true);
    expect(declined).toEqual([]);
  });

  it("keeps an override whose closure runs through ANOTHER healthy graph module", () => {
    // Transitivity in the good direction: a record → record → platform chain is fully resolvable and
    // must not be mistaken for a dead end just because the middle link is not in the registry.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/a"]),
      mod("@/a", ["@/components/panel"]),
      mod("@/components/panel", ["react"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/a", "react"));
    expect(declined).toEqual([]);
    expect(kept.size).toBe(3);
  });

  it("leaves an unsatisfiable module ALONE when the platform has no fallback — it must still fail loudly", () => {
    // A `@/components/<id>` sibling overrides nothing. Declining it would swap a named error for a blank
    // page, which is strictly worse: there is no bundled module to fall back to.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/components/panel"]),
      mod("@/components/panel", ["@/nope"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry(/* nothing available */));
    expect(kept.has("@/components/panel")).toBe(true);
    expect(declined).toEqual([]);
  });

  it("never declines the ENTRY — it overrides nothing and has nowhere to fall back to", () => {
    const linked = linkOf(mod(ENTRY_SPECIFIER, ["@/missing"]));
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry(ENTRY_SPECIFIER));
    expect(kept.has(ENTRY_SPECIFIER)).toBe(true);
    expect(declined).toEqual([]);
  });

  it("terminates on an import CYCLE between records rather than hanging", () => {
    // Cycles are a normal module shape — the linker and the eval cache both tolerate them, so the walk
    // here has to as well.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/a"]),
      mod("@/a", ["@/b"]),
      mod("@/b", ["@/a"]),
    );
    const { declined } = pruneUnsatisfiableOverrides(linked, registry("@/a", "@/b"));
    expect(declined).toEqual([]);
  });

  it("declines only the BROKEN member of a cycle — the other one still has a fallback", () => {
    // `@/b` is broken; `@/a` merely imports it. Since `@/b` has a platform fallback, `@/a`'s import of
    // it resolves either way, so `@/a` is untouched.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/a"]),
      mod("@/a", ["@/b"]),
      mod("@/b", ["@/a", "@/gone"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/a", "@/b"));
    expect(declined.map((d) => d.specifier)).toEqual(["@/b"]);
    expect(kept.has("@/a")).toBe(true);
  });

  it("does NOT punish a module for a broken neighbour that has its own fallback", () => {
    // The over-eager failure mode, pinned: `@/a`'s only unresolved import is `@/b`, and `@/b` is itself
    // broken. `@/b` is declined and falls back to the platform, so `@/a` still resolves and must be
    // KEPT — declining it too would silently revert a perfectly good migration one hop away.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/a"]),
      mod("@/a", ["@/b"]),
      mod("@/b", ["@/gone"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/a", "@/b"));
    expect(declined.map((d) => d.specifier)).toEqual(["@/b"]);
    expect(kept.has("@/a")).toBe(true);
  });

  it("DOES propagate through a sibling, which has no fallback of its own", () => {
    // The other direction: `@/components/panel` cannot fall back, so an override that reaches it
    // inherits its failure and is declined — otherwise the page would still die on the sibling.
    const linked = linkOf(
      mod(ENTRY_SPECIFIER, ["@/a"]),
      mod("@/a", ["@/components/panel"]),
      mod("@/components/panel", ["@/gone"]),
    );
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/a"));
    expect(declined).toEqual([{ specifier: "@/a", missing: "@/gone" }]);
    expect(kept.has("@/components/panel")).toBe(true);   // still there, still failing loudly
  });

  it("is a no-op on a fully healthy link — the common path costs nothing and changes nothing", () => {
    const linked = linkOf(mod(ENTRY_SPECIFIER, ["react"]), mod("@/x", ["react"]));
    const { linked: kept, declined } = pruneUnsatisfiableOverrides(linked, registry("@/x", "react"));
    expect(declined).toEqual([]);
    expect([...kept.keys()]).toEqual([ENTRY_SPECIFIER, "@/x"]);
  });
});
