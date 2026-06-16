import { describe, it, expect } from "vitest";
import { blueprintToManifest, manifestToBlueprint, coerceBlueprint } from "../screens/projects/blueprintShare";
import { encodeShareCode, decodeShareCode, wrapExtension } from "../lib/extensions/manifest";
import { makeBlueprints } from "../screens/projects/blueprints";
import { useAppStore } from "../store";

const sample = () => makeBlueprints().find((b) => b.id === "fullstack")!;

describe("blueprintShare (#598)", () => {
  it("round-trips a blueprint through the manifest (content preserved, fresh uids)", () => {
    const bp = sample();
    const m = blueprintToManifest(bp);
    expect(m.kind).toBe("blueprint");
    const back = manifestToBlueprint(m);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // Same structure...
    expect(back.blueprint.name).toBe(bp.name);
    expect(back.blueprint.sections.map((s) => s.key)).toEqual(bp.sections.map((s) => s.key));
    // ...but fresh uids (so an import can't alias the source's instances).
    expect(back.blueprint.sections[0].uid).not.toBe(bp.sections[0].uid);
  });

  it("round-trips through a share code end-to-end", () => {
    const bp = sample();
    const code = encodeShareCode(blueprintToManifest(bp));
    const decoded = decodeShareCode(code);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const back = manifestToBlueprint(decoded.manifest);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.sections.length).toBe(bp.sections.length);
  });

  it("rejects a non-blueprint manifest and malformed payloads", () => {
    expect(manifestToBlueprint(wrapExtension("pipeline", "p", "n", "1", {})).ok).toBe(false);
    expect(coerceBlueprint(null)).toBeNull();
    expect(coerceBlueprint({ id: "x", name: "y", sections: [] })).toBeNull(); // no valid sections
    expect(coerceBlueprint({ id: "x", name: "y", sections: [{ name: "no key" }] })).toBeNull();
  });

  it("coerces partial section/pipeline fields with safe defaults", () => {
    const bp = coerceBlueprint({
      id: "x", name: "Imported",
      sections: [{ key: "context", name: "Context", pipelines: [{ id: "lint-plan", name: "Lint", kind: "bogus", trigger: "bogus" }] }],
    });
    expect(bp).not.toBeNull();
    const p = bp!.sections[0].pipelines[0];
    expect(p.kind).toBe("custom");          // unknown kind → custom
    expect(p.trigger).toBe("on completion"); // unknown trigger → default
    expect(bp!.sections[0].glyph).toBe("✚"); // missing glyph → default
  });

  it("preserves attached skills + MCP servers + lifecycle metadata through import (#897)", () => {
    const bp = coerceBlueprint({
      id: "x", name: "Imported", category: "transform", mode: "operate",
      skills: ["bp-skill-1"], mcp: ["Compliance"],
      sections: [{
        key: "structure", name: "Structure",
        skills: ["sk-a", "sk-b"], mcp: ["Complexity Analyzer", "Dependency Graph"],
        optional: true, output: "issues",
      }],
    });
    expect(bp).not.toBeNull();
    // Blueprint-wide capabilities + metadata survive.
    expect(bp!.skills).toEqual(["bp-skill-1"]);
    expect(bp!.mcp).toEqual(["Compliance"]);
    expect(bp!.category).toBe("transform");
    expect(bp!.mode).toBe("operate");
    // Per-section capabilities + shape survive.
    const s = bp!.sections[0];
    expect(s.skills).toEqual(["sk-a", "sk-b"]);
    expect(s.mcp).toEqual(["Complexity Analyzer", "Dependency Graph"]);
    expect(s.optional).toBe(true);
    expect(s.output).toBe("issues");
  });

  it("ignores a bogus category/mode (falls back to undefined)", () => {
    const bp = coerceBlueprint({ id: "x", name: "y", category: "bogus", mode: "nope", sections: [{ key: "context", name: "Context" }] });
    expect(bp!.category).toBeUndefined();
    expect(bp!.mode).toBeUndefined();
  });
});

describe("blueprint CRUD store actions (#598)", () => {
  it("importBlueprint adds under a fresh id with fresh section uids", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    const before = useAppStore.getState().blueprints.length;
    const bp = sample();
    const newId = useAppStore.getState().importBlueprint(bp);
    const after = useAppStore.getState().blueprints;
    expect(after.length).toBe(before + 1);
    expect(newId).not.toBe(bp.id);
    const imported = after.find((b) => b.id === newId)!;
    expect(imported.sections[0].uid).not.toBe(bp.sections[0].uid);
  });

  it("removeBlueprint deletes it and reassigns active when needed", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    useAppStore.getState().removeBlueprint("default");
    const s = useAppStore.getState();
    expect(s.blueprints.some((b) => b.id === "default")).toBe(false);
    expect(s.activeBlueprintId).not.toBe("default"); // fell back to a remaining blueprint
    expect(s.blueprints.some((b) => b.id === s.activeBlueprintId)).toBe(true);
  });
});
