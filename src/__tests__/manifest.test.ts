import { describe, it, expect, beforeEach } from "vitest";
import {
  validateManifest, parseManifest,
  encodeShareCode, decodeShareCode,
  blueprintToManifest, manifestToBlueprint,
  type ExtensionManifest, type Blueprint,
} from "../lib/extensions/manifest";
import { useAppStore } from "../store";

// ── helpers ───────────────────────────────────────────────────────────────────

const mkManifest = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  kind: "blueprint",
  id: "bp_test",
  name: "Test Blueprint",
  version: "1",
  payload: { description: "d", sections: { goal: "ship it" } },
  ...over,
});

const mkBlueprint = (over: Partial<Blueprint> = {}): Blueprint => ({
  id: "bp_abc",
  name: "My Template",
  description: "A starter template",
  sections: { goal: "Build a CLI", stack: "Rust + TypeScript" },
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
});

// ── validateManifest ──────────────────────────────────────────────────────────

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateManifest(mkManifest())).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(validateManifest(null)).toBe(false);
    expect(validateManifest("string")).toBe(false);
    expect(validateManifest(42)).toBe(false);
    expect(validateManifest([])).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(validateManifest(mkManifest({ kind: "unknown" as never }))).toBe(false);
  });

  it("rejects empty id, name, or version", () => {
    expect(validateManifest(mkManifest({ id: "" }))).toBe(false);
    expect(validateManifest(mkManifest({ name: "" }))).toBe(false);
    expect(validateManifest(mkManifest({ version: "" }))).toBe(false);
  });

  it("accepts pipeline and mcp-extension kinds", () => {
    expect(validateManifest(mkManifest({ kind: "pipeline" }))).toBe(true);
    expect(validateManifest(mkManifest({ kind: "mcp-extension" }))).toBe(true);
  });
});

// ── parseManifest ─────────────────────────────────────────────────────────────

describe("parseManifest", () => {
  it("returns a manifest from a valid object", () => {
    const m = parseManifest(mkManifest());
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("blueprint");
    expect(m!.id).toBe("bp_test");
  });

  it("includes optional capabilities and integrity when present", () => {
    const m = parseManifest(mkManifest({ capabilities: ["read-signals"], integrity: "sha256:abc" }));
    expect(m!.capabilities).toEqual(["read-signals"]);
    expect(m!.integrity).toBe("sha256:abc");
  });

  it("drops non-string capability entries", () => {
    const m = parseManifest(mkManifest({ capabilities: ["ok", 123, null] as never }));
    expect(m!.capabilities).toEqual(["ok"]);
  });

  it("returns null for invalid input", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ kind: "blueprint", id: "x", name: "n" })).toBeNull(); // missing version+payload
  });
});

// ── share-code round-trip ─────────────────────────────────────────────────────

describe("encodeShareCode / decodeShareCode", () => {
  it("round-trips a manifest losslessly", () => {
    const m = mkManifest();
    const code = encodeShareCode(m);
    expect(typeof code).toBe("string");
    const decoded = decodeShareCode(code);
    expect(decoded).toEqual(m);
  });

  it("produces a URL-safe string (no +, /, or = characters)", () => {
    const code = encodeShareCode(mkManifest());
    expect(code).not.toMatch(/[+/=]/);
  });

  it("returns null for garbage input", () => {
    expect(decodeShareCode("notbase64!!!")).toBeNull();
    expect(decodeShareCode("aGVsbG8=")).toBeNull(); // valid base64 but not a manifest
    expect(decodeShareCode("")).toBeNull();
  });

  it("round-trips a manifest with capabilities and integrity", () => {
    const m = mkManifest({ capabilities: ["write-files"], integrity: "sha256:deadbeef" });
    expect(decodeShareCode(encodeShareCode(m))).toEqual(m);
  });
});

// ── blueprint ↔ manifest ──────────────────────────────────────────────────────

describe("blueprintToManifest / manifestToBlueprint", () => {
  it("round-trips a blueprint losslessly (id, name, sections, phases)", () => {
    const bp = mkBlueprint({ phases: '[{"name":"Phase 1","description":"MVP"}]' });
    const manifest = blueprintToManifest(bp);
    expect(manifest.kind).toBe("blueprint");
    expect(manifest.id).toBe(bp.id);
    expect(manifest.name).toBe(bp.name);

    const back = manifestToBlueprint(manifest, 999);
    expect(back).not.toBeNull();
    expect(back!.id).toBe(bp.id);
    expect(back!.name).toBe(bp.name);
    expect(back!.description).toBe(bp.description);
    expect(back!.sections).toEqual(bp.sections);
    expect(back!.phases).toBe(bp.phases);
    // Timestamps are re-minted from the `now` argument.
    expect(back!.createdAt).toBe(999);
    expect(back!.updatedAt).toBe(999);
  });

  it("omits phases from the manifest payload when undefined", () => {
    const bp = mkBlueprint(); // no phases
    const manifest = blueprintToManifest(bp);
    expect((manifest.payload as Record<string, unknown>).phases).toBeUndefined();
  });

  it("returns null for non-blueprint manifests", () => {
    expect(manifestToBlueprint(mkManifest({ kind: "pipeline" }))).toBeNull();
  });

  it("returns null for a blueprint manifest with a bad payload", () => {
    expect(manifestToBlueprint(mkManifest({ payload: "oops" }))).toBeNull();
    expect(manifestToBlueprint(mkManifest({ payload: null }))).toBeNull();
  });

  it("handles a sections payload with non-string values gracefully (drops them)", () => {
    const manifest = mkManifest({
      payload: { description: "d", sections: { goal: "ok", bad: 42 } },
    });
    const bp = manifestToBlueprint(manifest, 1);
    expect(bp!.sections).toEqual({ goal: "ok" });
  });
});

// ── store CRUD + importBlueprint ──────────────────────────────────────────────

describe("blueprint store actions", () => {
  beforeEach(() => {
    useAppStore.setState({ blueprints: [] });
  });

  it("addBlueprint inserts with a generated id and timestamps", () => {
    useAppStore.getState().addBlueprint({ name: "A", description: "d", sections: { goal: "x" } });
    const bps = useAppStore.getState().blueprints;
    expect(bps).toHaveLength(1);
    expect(bps[0].id).toMatch(/^bp_/);
    expect(bps[0].name).toBe("A");
    expect(bps[0].createdAt).toBeGreaterThan(0);
  });

  it("renameBlueprint updates name and updatedAt", () => {
    useAppStore.getState().addBlueprint({ name: "Old", description: "", sections: {} });
    const id = useAppStore.getState().blueprints[0].id;
    const before = useAppStore.getState().blueprints[0].updatedAt;
    useAppStore.getState().renameBlueprint(id, "New");
    const bp = useAppStore.getState().blueprints[0];
    expect(bp.name).toBe("New");
    expect(bp.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("duplicateBlueprint appends a copy with a new id and ' (copy)' suffix", () => {
    useAppStore.getState().addBlueprint({ name: "Orig", description: "d", sections: { goal: "y" } });
    const id = useAppStore.getState().blueprints[0].id;
    useAppStore.getState().duplicateBlueprint(id);
    const bps = useAppStore.getState().blueprints;
    expect(bps).toHaveLength(2);
    expect(bps[1].name).toBe("Orig (copy)");
    expect(bps[1].id).not.toBe(id);
    expect(bps[1].sections).toEqual(bps[0].sections);
  });

  it("removeBlueprint drops the entry by id", () => {
    useAppStore.getState().addBlueprint({ name: "A", description: "", sections: {} });
    useAppStore.getState().addBlueprint({ name: "B", description: "", sections: {} });
    const id = useAppStore.getState().blueprints[0].id;
    useAppStore.getState().removeBlueprint(id);
    const bps = useAppStore.getState().blueprints;
    expect(bps).toHaveLength(1);
    expect(bps[0].name).toBe("B");
  });

  it("importBlueprint inserts from a valid blueprint manifest", () => {
    const manifest = blueprintToManifest(mkBlueprint());
    const ok = useAppStore.getState().importBlueprint(manifest);
    expect(ok).toBe(true);
    const bps = useAppStore.getState().blueprints;
    expect(bps).toHaveLength(1);
    expect(bps[0].name).toBe("My Template");
    expect(bps[0].sections).toEqual({ goal: "Build a CLI", stack: "Rust + TypeScript" });
  });

  it("importBlueprint updates an existing blueprint with the same origin id", () => {
    const bp = mkBlueprint();
    useAppStore.getState().importBlueprint(blueprintToManifest(bp));
    // Import again with updated name.
    const updated = blueprintToManifest({ ...bp, name: "Updated Template" });
    useAppStore.getState().importBlueprint(updated);
    const bps = useAppStore.getState().blueprints;
    expect(bps).toHaveLength(1);
    expect(bps[0].name).toBe("Updated Template");
  });

  it("importBlueprint returns false for a non-blueprint manifest", () => {
    const ok = useAppStore.getState().importBlueprint(mkManifest({ kind: "pipeline" }));
    expect(ok).toBe(false);
    expect(useAppStore.getState().blueprints).toHaveLength(0);
  });
});
