import { describe, it, expect } from "vitest";
import { blueprintToManifest, manifestToBlueprint, coerceBlueprint, bundledSkillsFromManifest } from "../screens/projects/blueprintShare";
import { resolveBlueprintSkillPayloads, type SkillPayload } from "../screens/projects/blueprintSkills";
import { skillFromPayload } from "../lib/skills";
import { encodeShareCode, decodeShareCode, wrapExtension } from "../lib/extensions/manifest";
import { makeBlueprints } from "../screens/projects/blueprints";
import { useAppStore } from "../store";
import type { Blueprint } from "../screens/projects/blueprints";
import type { SkillDef } from "../lib/skills";
import type { KbBlock } from "../data/mock";

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

  it("allowEmptySections accepts a section-less in-progress blueprint (#923 authoring)", () => {
    // The Purpose stage emits identity (name/category) before any stages exist — strict import would
    // drop it, so the <blueprint> tag handler opts into allowEmptySections.
    expect(coerceBlueprint({ id: "x", name: "y", category: "greenfield", sections: [] })).toBeNull();
    const bp = coerceBlueprint({ id: "x", name: "y", category: "greenfield", sections: [] }, { allowEmptySections: true });
    expect(bp).not.toBeNull();
    expect(bp!.name).toBe("y");
    expect(bp!.category).toBe("greenfield");
    expect(bp!.sections).toEqual([]);
    // still requires id + name even when empty sections are allowed
    expect(coerceBlueprint({ name: "no id", sections: [] }, { allowEmptySections: true })).toBeNull();
  });

  it("coerces partial section fields with safe defaults", () => {
    const bp = coerceBlueprint({
      id: "x", name: "Imported",
      sections: [{ key: "context", name: "Context", skills: ["sk1"], mcp: ["Compliance"] }],
    });
    expect(bp).not.toBeNull();
    expect(bp!.sections[0].glyph).toBe("✚"); // missing glyph → default
    expect(bp!.sections[0].skills).toEqual(["sk1"]);
    expect(bp!.sections[0].mcp).toEqual(["Compliance"]);
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

  it("bundles attached skill CONTENT and round-trips it through the manifest (#897 Phase 5b)", () => {
    const skills: SkillDef[] = [{
      id: "sk1", name: "Rust HMAC", kind: "workflow", source: "team", desc: "hmac mw", prompt: "## procedure\nverify hmac",
      tools: ["Edit"], profiles: [], projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, trend: [],
    }];
    const kb: KbBlock[] = [{ id: "kb1", title: "Retry policy", tags: ["reliability"], updated: "now", lines: 3, content: "backoff + jitter" }];
    const bp = {
      id: "x", name: "BP", desc: "", skills: ["kb1"],
      sections: [{ uid: "u", key: "structure", name: "Structure", glyph: "◆", gate: "", deps: [], blurb: "", prompt: "", enabled: true, expanded: false, skills: ["sk1"] }],
    } as unknown as Blueprint;

    const bundled = resolveBlueprintSkillPayloads(bp, skills, kb);
    expect(bundled.map((p) => p.id).sort()).toEqual(["kb1", "sk1"]);
    expect(bundled.find((p) => p.id === "sk1")).toMatchObject({ kind: "skill", content: "## procedure\nverify hmac", skillKind: "workflow", tools: ["Edit"] });
    expect(bundled.find((p) => p.id === "kb1")).toMatchObject({ kind: "kb", content: "backoff + jitter", tags: ["reliability"] });

    // The content survives a manifest round-trip (the share envelope).
    const out = bundledSkillsFromManifest(blueprintToManifest(bp, bundled));
    expect(out.find((p) => p.id === "sk1")!.content).toBe("## procedure\nverify hmac");
    expect(out.find((p) => p.id === "kb1")!.tags).toEqual(["reliability"]);
    // A share with no bundled skills carries none (old shares / nothing attached).
    expect(bundledSkillsFromManifest(blueprintToManifest(bp))).toEqual([]);
  });

  it("skillFromPayload reconstitutes a skill with its id + content, marked imported", () => {
    const p: SkillPayload = { id: "sk1", name: "Rust HMAC", kind: "skill", content: "verify", desc: "d", skillKind: "review", tools: ["Read"] };
    const def = skillFromPayload(p);
    expect(def).toMatchObject({ id: "sk1", name: "Rust HMAC", prompt: "verify", desc: "d", kind: "review", tools: ["Read"], source: "imported", enabled: true });
    // A bogus/absent skillKind falls back to a valid kind.
    expect(["workflow", "scaffold", "codemod", "review", "docs"]).toContain(skillFromPayload({ id: "a", name: "b", content: "c" }).kind);
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
