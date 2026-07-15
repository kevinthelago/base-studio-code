// Library-module resolution (#3116) — the Design Studio's bridge from a `@bsc/algorithms/…` import to the
// resolved node + the vendorable preview module. Reads the PACKAGED seed (the flagship fibonacci.ts).
import { describe, it, expect } from "vitest";
import { resolveLibrarySpec, libraryModuleResolver } from "./libraryModules";

describe("resolveLibrarySpec (#3116)", () => {
  it("resolves @bsc/algorithms/fibonacci against the TypeScript algorithm kit", () => {
    const n = resolveLibrarySpec("@bsc/algorithms/fibonacci");
    expect(n).not.toBeNull();
    expect(n!.graph).toBe("algo");
    expect(n!.kit).toBe("typescript");
    expect(n!.label).toBe("fibonacci");
    expect(n!.code).toContain("fibonacci");
    // The URN is canonical (built from the resolved impl id).
    expect(n!.urn).toBe("algo:typescript/fibonacci.ts");
  });

  it("canonicalizes the bare name and the exact id to ONE node", () => {
    expect(resolveLibrarySpec("@bsc/algorithms/fibonacci")!.urn)
      .toBe(resolveLibrarySpec("@bsc/algorithms/fibonacci.ts")!.urn);
  });

  it("returns null for a missing algorithm, a graph with no vendor path here, and a non-@bsc spec", () => {
    expect(resolveLibrarySpec("@bsc/algorithms/nope")).toBeNull();
    expect(resolveLibrarySpec("@bsc/ui/Sparkline")).toBeNull(); // no ui vendor path in this slice
    expect(resolveLibrarySpec("@bsc/sounds/click")).toBeNull();
    expect(resolveLibrarySpec("d3")).toBeNull();
    expect(resolveLibrarySpec("@/shared/ui/data/Card")).toBeNull();
  });
});

describe("libraryModuleResolver (#3116)", () => {
  it("vendors fibonacci as a preview module keyed by the import specifier + .ts", () => {
    const mod = libraryModuleResolver("@bsc/algorithms/fibonacci");
    expect(mod).not.toBeNull();
    expect(mod!.path).toBe("@bsc/algorithms/fibonacci.ts");
    expect(mod!.source).toContain("export function fibonacci");
  });

  it("keeps an already-extensioned specifier's path (no double extension)", () => {
    expect(libraryModuleResolver("@bsc/algorithms/fibonacci.ts")!.path).toBe("@bsc/algorithms/fibonacci.ts");
  });

  it("returns null for a primitive (no code → not importable) and a missing name", () => {
    expect(libraryModuleResolver("@bsc/algorithms/number")).toBeNull();
    expect(libraryModuleResolver("@bsc/algorithms/nope")).toBeNull();
  });
});
