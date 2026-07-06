import { describe, it, expect } from "vitest";
import { SEED_COMPONENTS } from "./seed";
import { componentRules } from "./rules";
import { ROLES } from "./model";

// The `examples` kit is the canonical EXEMPLAR of a complete kit (#2456): a small, coherent demo app
// whose composition graph reads as the model hierarchy at a glance — page roots → layout shell →
// composites → primitives, plus one service — with every record-shape feature exercised at least once.
const EXAMPLES = SEED_COMPONENTS.filter((c) => c.kitId === "examples");
const byName = (n: string) => EXAMPLES.find((c) => c.name === n);

describe("examples exemplar kit (#2456)", () => {
  it("drops the prototype spring-kotlin/tauri-rust service demos", () => {
    for (const gone of ["PersonaService", "BscBridge", "CommandRouter", "FsWatcher"]) {
      expect(byName(gone), `${gone} should be gone from the seed`).toBeUndefined();
    }
  });

  it("stays small and legible — a clean page→primitive pyramid, not a catalog", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(EXAMPLES.length).toBeLessThanOrEqual(14);
  });

  it("represents all five roles", () => {
    const roles = new Set(EXAMPLES.map((c) => c.role));
    for (const r of ROLES) expect(roles.has(r), `no ${r}-role component`).toBe(true);
    // More than one page root, so the top band of the graph isn't a single node.
    expect(EXAMPLES.filter((c) => c.role === "page").length).toBeGreaterThanOrEqual(2);
  });

  it("every component is transitively reachable from a page-role root — zero isolated nodes", () => {
    const reachable = new Set<string>();
    const visit = (name: string) => {
      if (reachable.has(name)) return;
      reachable.add(name);
      byName(name)?.composes.forEach(visit);
    };
    EXAMPLES.filter((c) => c.role === "page").forEach((p) => visit(p.name));
    for (const c of EXAMPLES) {
      expect(reachable.has(c.name), `${c.name} is an isolated node — not composed into any page`).toBe(true);
    }
  });

  it("composes only its OWN components — compose resolution is name-based across the store, and cross-kit edges don't render in the per-kit graph", () => {
    const own = new Set(EXAMPLES.map((c) => c.name));
    const reactUi = new Set(SEED_COMPONENTS.filter((c) => c.kitId === "react-ui").map((c) => c.name));
    for (const c of EXAMPLES) {
      expect(reactUi.has(c.name), `${c.name} collides with a react-ui component name`).toBe(false);
      for (const dep of c.composes) expect(own.has(dep), `${c.name} composes ${dep}, which is not in the kit`).toBe(true);
    }
  });

  it("exercises the full record shape: multi-variant, wraps → derived rule, an authored rule, req+opt props, guidance", () => {
    // >1 variants on at least one component (the preview cycles them).
    expect(EXAMPLES.some((c) => c.variants.length > 1)).toBe(true);
    // A raw-intrinsic replacement that derives the anti-duplication lint rule.
    const demoButton = byName("DemoButton")!;
    expect(demoButton.wraps).toBe("button");
    const derived = componentRules(demoButton).find((r) => r.kind === "forbid-element" && r.target === "button");
    expect(derived?.use).toBe("DemoButton");
    // An author-declared rule (beyond the wraps-derived ones).
    const authored = EXAMPLES.flatMap((c) => c.rules ?? []);
    expect(authored.some((r) => r.kind === "forbid-import")).toBe(true);
    // Props mix required and optional; every component carries when-use/when-not guidance.
    const props = EXAMPLES.flatMap((c) => c.props);
    expect(props.some((p) => p.req)).toBe(true);
    expect(props.some((p) => !p.req)).toBe(true);
    for (const c of EXAMPLES) {
      expect(c.whenUse.length, `${c.name} missing whenUse guidance`).toBeGreaterThan(0);
      expect(c.whenNot.length, `${c.name} missing whenNot guidance`).toBeGreaterThan(0);
      expect(c.src, `${c.name} missing src`).toBeTruthy();
      expect(c.srcText, `${c.name} missing srcText`).toBeTruthy();
    }
  });

  it("service is placed under a page like everything else — PersonasPanel composes PersonaStore", () => {
    expect(byName("PersonaStore")!.role).toBe("service");
    expect(byName("PersonasPanel")!.composes).toContain("PersonaStore");
  });
});
