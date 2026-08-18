import { describe, expect, it } from "vitest";
import { importsSiblingsByRecordId } from "./lib/recordSource.mjs";

// A record that imports `@/components/<id>` is GRAPH-LOADER-ONLY: that specifier is resolved against the
// record store at runtime and is not a path, so the record cannot be materialized into `.bsc-records/`
// and imported by the bundle. Retiring its file therefore breaks the build — which is what happened to
// four page files before this predicate existed, and `platformModules.gen.test.ts` was the only check in
// the whole gate that noticed ("Cannot find package '@/components/algorithms-kit-graph'").
describe("importsSiblingsByRecordId — the graph-only record predicate (retirement guard)", () => {
  it("flags a record that imports a sibling by record id", () => {
    const src = [
      `import { useState } from "react";`,
      `import { AlgorithmsKitGraph } from "@/components/algorithms-kit-graph";`,
      `import { AlgorithmsRail } from "@/components/algorithms-rail";`,
      `export function AlgorithmsWorkspace() { return null; }`,
    ].join("\n");
    const { any, specifiers } = importsSiblingsByRecordId(src);
    expect(any).toBe(true);
    expect(specifiers).toEqual(["@/components/algorithms-kit-graph", "@/components/algorithms-rail"]);
  });

  it("does NOT flag a record that imports only real module specifiers", () => {
    const src = [
      `import { useState } from "react";`,
      `import { Card } from "@/shared/ui/data/Card";`,
      `import { GlanceCanvas } from "@/features/glance/GlanceCanvas";`,
      `export function Thing() { return null; }`,
    ].join("\n");
    expect(importsSiblingsByRecordId(src).any).toBe(false);
  });

  it("de-duplicates repeated sibling ids", () => {
    const src = [
      `import { A } from "@/components/x";`,
      `import type { B } from "@/components/x";`,
    ].join("\n");
    expect(importsSiblingsByRecordId(src).specifiers).toEqual(["@/components/x"]);
  });

  it("is quote-agnostic — a single-quoted import is the same hazard", () => {
    expect(importsSiblingsByRecordId(`import { A } from '@/components/y';`).any).toBe(true);
  });

  it("treats empty or absent source as clean rather than throwing", () => {
    expect(importsSiblingsByRecordId("").any).toBe(false);
    expect(importsSiblingsByRecordId(undefined).any).toBe(false);
  });
});
