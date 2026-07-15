// Library-module resolution (#3116) — the Design Studio's bridge from a `@bsc/algorithms/…` import to the
// resolved node + the vendorable preview module. Reads the PACKAGED seed (the flagship fibonacci.ts).
import { describe, it, expect } from "vitest";
import { resolveLibrarySpec, libraryModuleResolver, libraryReimplTargets } from "./libraryModules";

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
    expect(resolveLibrarySpec("@bsc/sounds/nope")).toBeNull(); // sounds resolves now — but not a missing cue
    expect(resolveLibrarySpec("d3")).toBeNull();
    expect(resolveLibrarySpec("@/shared/ui/data/Card")).toBeNull();
  });
});

describe("resolveLibrarySpec — sounds (#3117)", () => {
  it("resolves @bsc/sounds/click against the default sound kit as a cue node with a player module", () => {
    const n = resolveLibrarySpec("@bsc/sounds/click");
    expect(n).not.toBeNull();
    expect(n!.graph).toBe("sound");
    expect(n!.kit).toBe("signal"); // the default (first built-in) sound kit
    expect(n!.kind).toBe("cue");
    expect(n!.label).toBe("Click");
    expect(n!.urn).toBe("sound:signal/click");
    expect(n!.code).toContain("export function play"); // the self-contained player module
  });

  it("falls back to a voice (a playable patch) and misses cleanly on an unknown id", () => {
    expect(resolveLibrarySpec("@bsc/sounds/blip")!.kind).toBe("voice");
    expect(resolveLibrarySpec("@bsc/sounds/blip")!.code).toContain("export function play");
    expect(resolveLibrarySpec("@bsc/sounds/nope")).toBeNull();
  });

  it("resolves a primitive as a code-less descriptor (not importable)", () => {
    const n = resolveLibrarySpec("@bsc/sounds/sine");
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("primitive");
    expect(n!.code).toBeUndefined();
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

describe("libraryModuleResolver — sounds (#3117)", () => {
  it("vendors a sound cue as a self-contained player module (path keyed by the specifier + .ts)", () => {
    const mod = libraryModuleResolver("@bsc/sounds/click");
    expect(mod).not.toBeNull();
    expect(mod!.path).toBe("@bsc/sounds/click.ts");
    expect(mod!.source).toContain("export function play"); // the export API a component binds
    expect(mod!.source).toContain("const SCHEDULE ="); // the embedded compiled schedule
    expect(mod!.source).toContain("\"voices\""); // …which carries the compiled voice list
  });

  it("returns null for a sound primitive (no player) and a missing cue", () => {
    expect(libraryModuleResolver("@bsc/sounds/sine")).toBeNull(); // a primitive descriptor — no code
    expect(libraryModuleResolver("@bsc/sounds/nope")).toBeNull();
  });
});

describe("libraryReimplTargets (#3118)", () => {
  const targets = libraryReimplTargets();

  it("lists the TS algorithm by bare name — ALGORITHMS-ONLY, sounds excluded", () => {
    expect(targets).toContainEqual({ name: "fibonacci", segment: "algorithms", importSpec: "@bsc/algorithms/fibonacci" });
    // Sounds are deliberately excluded (#3118): every candidate is an algorithm, and a sound cue id
    // (`click`) — which collides with common handler names — is NOT a candidate.
    expect(targets.every((t) => t.segment === "algorithms")).toBe(true);
    expect(targets.some((t) => t.name === "click")).toBe(false);
  });

  it("excludes the algo id's extension form (fibonacci.ts) — only declarable identifiers", () => {
    // The extension-bearing algo id can never be a `function <name>` declaration.
    expect(targets.some((t) => t.name === "fibonacci.ts")).toBe(false);
    expect(targets.some((t) => t.name.includes("."))).toBe(false);
  });

  it("only lists names that actually resolve to a library node", () => {
    // Every candidate is a real, vendorable node — the guardrail never steers to a phantom import.
    for (const t of targets) expect(resolveLibrarySpec(t.importSpec)).not.toBeNull();
  });
});
