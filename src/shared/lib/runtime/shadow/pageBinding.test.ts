// The binding half of the shadow verdict (#4169) — "which behaviors are unbound". This is the list the
// registry work (step 3) is driven from, and the predicate step 2's resolution chain will gate on, so it
// has to mirror what the loader actually does: vendor graph siblings, require everything else.
import { describe, it, expect } from "vitest";
import { parseImports, analyzeBindings, type SiblingResolver } from "./pageBinding";

describe("parseImports", () => {
  it("reads every import form, with the names taken from each module", () => {
    const src = [
      `import React from "react";`,
      `import * as api from "@/shared/lib/api";`,
      `import { useAppStore } from "@/store";`,
      `import { Row, Chip as Pill } from "@/shared/ui/kit";`,
      `import {`,
      `  usePoll,`,
      `  useDraft,`,
      `} from "@/shared/hooks";`,
      `import "./page.css";`,
    ].join("\n");
    expect(parseImports(src)).toEqual([
      { specifier: "react", symbols: ["default"] },
      { specifier: "@/shared/lib/api", symbols: ["*"] },
      { specifier: "@/store", symbols: ["useAppStore"] },
      { specifier: "@/shared/ui/kit", symbols: ["Row", "Chip"] }, // the MODULE's name, not the alias
      { specifier: "@/shared/hooks", symbols: ["usePoll", "useDraft"] },
      { specifier: "./page.css", symbols: [] },
    ]);
  });

  it("counts a re-export — esbuild compiles it to the same require", () => {
    // Scanning only `import` is how projectspage shipped broken (#3874): the unregistered specifier came
    // in via `export { ProjectRow } from "./published/ProjectRow"`.
    expect(parseImports(`export { ProjectRow } from "./published/ProjectRow";`))
      .toEqual([{ specifier: "./published/ProjectRow", symbols: ["ProjectRow"] }]);
  });

  it("drops type-only imports — they are erased, so they can never be unbound", () => {
    const src = [
      `import type { AppStore } from "@/store/types";`,
      `export type { Role } from "./model";`,
      `import { type Density } from "./skillsFilter";`,
      `import { type SortKey, filterSkills } from "./skillsFilter2";`,
    ].join("\n");
    // Only the clause that still binds a VALUE survives — and it survives with its value symbol.
    expect(parseImports(src)).toEqual([{ specifier: "./skillsFilter2", symbols: ["SortKey", "filterSkills"] }]);
  });

  it("does not invent an import by running past a side-effect import", () => {
    // `import "./x.css"` has no `from`; a greedy scan would swallow it and attribute its symbols to the
    // next specifier.
    expect(parseImports(`import "./a.css";\nimport { b } from "c";`)).toEqual([
      { specifier: "c", symbols: ["b"] },
      { specifier: "./a.css", symbols: [] },
    ]);
  });
});

describe("analyzeBindings", () => {
  const registry = new Set(["react", "@/store", "@/shared/ui/kit"]);
  const isRegistered = (s: string) => registry.has(s);

  /** A resolver over an id → source map, mirroring the app's `@/components/<id>` sibling form. */
  const siblings = (map: Record<string, string>): SiblingResolver => (spec) => {
    const id = spec.startsWith("@/components/") ? spec.slice("@/components/".length) : "";
    return map[id] ? { id, source: map[id] } : null;
  };

  it("vendors siblings and reports only what stays external", () => {
    const page = { id: "mcppage", source: `import { A } from "@/components/mcp-a";\nimport { useAppStore } from "@/store";` };
    const report = analyzeBindings(page, siblings({ "mcp-a": `import { Row } from "@/shared/ui/kit";` }), isRegistered);
    expect(report.vendored).toEqual(["mcppage", "mcp-a"]);
    expect(report.external.map((e) => e.specifier)).toEqual(["@/shared/ui/kit", "@/store"]);
    expect(report.unbound).toEqual([]);
  });

  it("names the unbound behaviours and who asked for them", () => {
    const page = { id: "p", source: `import { A } from "@/components/a";\nimport { usePoll } from "@/shared/hooks/usePoll";` };
    const report = analyzeBindings(
      page,
      siblings({ a: `import { bscJson } from "@/features/mcp/lib/telemetry";` }),
      isRegistered,
    );
    expect(report.unbound.map((u) => u.specifier)).toEqual(["@/features/mcp/lib/telemetry", "@/shared/hooks/usePoll"]);
    // The symbols ARE the behaviour names — what the page needs the registry to hand it.
    expect(report.unbound[0]).toEqual({
      specifier: "@/features/mcp/lib/telemetry",
      symbols: ["bscJson"],
      importedBy: ["a"], // …and the sibling that wants it, not just the page
    });
  });

  it("merges a specifier imported by several modules", () => {
    const page = { id: "p", source: `import { A } from "@/components/a";\nimport { x } from "@/lib/shared";` };
    const report = analyzeBindings(page, siblings({ a: `import { y } from "@/lib/shared";` }), isRegistered);
    expect(report.unbound).toHaveLength(1);
    expect(report.unbound[0].symbols).toEqual(["x", "y"]);
    expect(report.unbound[0].importedBy).toEqual(["p", "a"]);
  });

  it("terminates on a sibling cycle", () => {
    const map = { a: `import { B } from "@/components/b";`, b: `import { A } from "@/components/a";` };
    const report = analyzeBindings({ id: "a", source: map.a }, siblings(map), isRegistered);
    expect(report.vendored).toEqual(["a", "b"]);
  });

  it("treats a MISSING sibling as unbound — the loader would throw on it", () => {
    // `@/components/<id>` has no physical module: unresolved, it reaches `makeRequire` and throws by name.
    const report = analyzeBindings({ id: "p", source: `import { X } from "@/components/gone";` }, siblings({}), isRegistered);
    expect(report.unbound.map((u) => u.specifier)).toEqual(["@/components/gone"]);
  });
});
