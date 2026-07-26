import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { blueprintToManifest, manifestToBlueprint, coerceBlueprint, coerceTeam, coerceUiKit, coerceSoundKit, coerceFleetPolicy, bundledSkillsFromManifest } from "./blueprintShare";
import type { BlueprintTeam, FleetPolicy } from "../stages/blueprints";
import { DEFAULT_FLOW } from "../fleet/agentFlow";
import { resolveBlueprintSkillPayloads, type SkillPayload } from "./blueprintSkills";
import { skillFromPayload } from "@/features/skills/lib/skills";
import { encodeShareCode, decodeShareCode, wrapExtension } from "@/features/planner/lib/gist/manifest";
import { makeBlueprints } from "../stages/blueprints";
import { useAppStore } from "@/store";
import type { Blueprint } from "../stages/blueprints";
import type { SkillDef } from "@/features/skills/lib/skills";

const sample = () => makeBlueprints().find((b) => b.id === "default")!;

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
    expect(manifestToBlueprint(wrapExtension("skill", "s", "n", "1", {})).ok).toBe(false);
    expect(coerceBlueprint(null)).toBeNull();
    expect(coerceBlueprint({ id: "x", name: "y", sections: [] })).toBeNull(); // no valid sections
    expect(coerceBlueprint({ id: "x", name: "y", sections: [{ name: "no key" }] })).toBeNull();
  });

  it("accepts the planner-facing `stages` field as an alias for sections (#923)", () => {
    // The planner emits `stages` (the planning-process term + the design's name); coerceBlueprint
    // maps it onto the internal `sections`. Stages = the planning STEPS, one per pane.
    const bp = coerceBlueprint({
      id: "x", name: "Authored", category: "greenfield",
      stages: [{ key: "discovery", name: "Discovery" }, { key: "streams", name: "Streams" }],
    });
    expect(bp).not.toBeNull();
    expect(bp!.sections.map((s) => s.key)).toEqual(["discovery", "streams"]);
    // `stages` wins when both are present (it's the canonical planner-facing field).
    const both = coerceBlueprint({
      id: "y", name: "Both",
      stages: [{ key: "discovery", name: "Discovery" }],
      sections: [{ key: "repos", name: "Repos" }, { key: "ui", name: "UI" }],
    });
    expect(both!.sections.map((s) => s.key)).toEqual(["discovery"]);
  });

  it("allowEmptySections accepts a section-less in-progress blueprint (#923 authoring)", () => {
    // The Purpose stage emits identity (name/category) before any stages exist — strict import would
    // drop it, so the <blueprint> tag handler opts into allowEmptySections.
    expect(coerceBlueprint({ id: "x", name: "y", sections: [] })).toBeNull();
    const bp = coerceBlueprint({ id: "x", name: "y", sections: [] }, { allowEmptySections: true });
    expect(bp).not.toBeNull();
    expect(bp!.name).toBe("y");
    expect(bp!.sections).toEqual([]);
    // still requires id + name even when empty sections are allowed
    expect(coerceBlueprint({ name: "no id", sections: [] }, { allowEmptySections: true })).toBeNull();
  });

  it("coerces partial section fields with safe defaults", () => {
    const bp = coerceBlueprint({
      id: "x", name: "Imported",
      sections: [{ key: "discovery", name: "Discovery", skills: ["sk1"], mcp: ["Compliance"] }],
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
        key: "streams", name: "Streams",
        skills: ["sk-a", "sk-b"], mcp: ["Complexity Analyzer", "Dependency Graph"],
        optional: true, output: "issues",
      }],
    });
    expect(bp).not.toBeNull();
    // Blueprint-wide capabilities + metadata survive.
    expect(bp!.skills).toEqual(["bp-skill-1"]);
    expect(bp!.mcp).toEqual(["Compliance"]);
    expect(bp!.mode).toBe("operate");
    // Per-section capabilities + shape survive import.
    const s = bp!.sections[0];
    expect(s.key).toBe("streams");
    expect(s.skills).toEqual(["sk-a", "sk-b"]);
    expect(s.mcp).toEqual(["Complexity Analyzer", "Dependency Graph"]);
    expect(s.optional).toBe(true);
    expect(s.output).toBe("issues");
  });

  it("ignores a bogus mode (falls back to undefined)", () => {
    const bp = coerceBlueprint({ id: "x", name: "y", mode: "nope", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(bp!.mode).toBeUndefined();
  });

  it("DROPS a legacy `category` from an old shared blueprint (#3785)", () => {
    // Blueprints shared before lifecycle left the model still carry the field; it must not
    // survive import onto the current model.
    const bp = coerceBlueprint({ id: "x", name: "y", category: "transform", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(bp).not.toBeNull();
    expect(bp).not.toHaveProperty("category");
  });

  it("bundles attached skill CONTENT and round-trips it through the manifest (#897 Phase 5b)", () => {
    const skills: SkillDef[] = [{
      id: "sk1", name: "Rust HMAC", kind: "workflow", source: "team", desc: "hmac mw", prompt: "## procedure\nverify hmac",
      tools: ["Edit"], profiles: [], projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, trend: [],
    }, {
      id: "sk2", name: "Retry policy", kind: "review", source: "team", desc: "reliability", prompt: "backoff + jitter",
      tools: ["Read"], profiles: [], projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, trend: [],
    }];
    const bp = {
      id: "x", name: "BP", desc: "", skills: ["sk2"],
      sections: [{ uid: "u", key: "streams", name: "Streams", glyph: "◆", icon: "checklist", hue: 70, gate: "", deps: [], blurb: "", prompt: "", enabled: true, expanded: false, skills: ["sk1"] }],
    } as unknown as Blueprint;

    const bundled = resolveBlueprintSkillPayloads(bp, skills);
    expect(bundled.map((p) => p.id).sort()).toEqual(["sk1", "sk2"]);
    expect(bundled.find((p) => p.id === "sk1")).toMatchObject({ kind: "skill", content: "## procedure\nverify hmac", skillKind: "workflow", tools: ["Edit"] });
    expect(bundled.find((p) => p.id === "sk2")).toMatchObject({ kind: "skill", content: "backoff + jitter", skillKind: "review" });

    // The content survives a manifest round-trip (the share envelope).
    const out = bundledSkillsFromManifest(blueprintToManifest(bp, bundled));
    expect(out.find((p) => p.id === "sk1")!.content).toBe("## procedure\nverify hmac");
    expect(out.find((p) => p.id === "sk2")!.content).toBe("backoff + jitter");
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

describe("embedded team (#2450)", () => {
  const team = (): BlueprintTeam => ({
    positions: [
      { nodeId: "n1", kind: "agent", personaId: "persona-director", x: 10, y: 20 },
      { nodeId: "n2", kind: "resource", label: "Commons", x: 100, y: 200 },
    ],
    relationships: [{ id: "r1", archetype: "stewards", from: "n1", to: "n2", bow: 24 }],
  });

  it("coerceBlueprint preserves the team byte-faithfully; a blueprint without one stays without one", () => {
    const withTeam = coerceBlueprint({
      id: "x", name: "Teamed", team: team(),
      sections: [{ key: "discovery", name: "Discovery" }],
    });
    expect(withTeam!.team).toEqual(team());
    // No `team` in the payload → the coerced blueprint carries NO team key (optional field,
    // untouched behavior for existing blueprints).
    const without = coerceBlueprint({ id: "x", name: "Plain", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(without).not.toBeNull();
    expect("team" in without!).toBe(false);
  });

  it("round-trips the team through the share manifest (export/import)", () => {
    const bp: Blueprint = { ...sample(), team: team() };
    const back = manifestToBlueprint(blueprintToManifest(bp));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.team).toEqual(team());
  });

  it("round-trips the team through the `bsc blueprint` store serialization (verbatim JSON)", () => {
    // The write-through store persists the blueprint verbatim on stdin (`bsc blueprint set`, #2143)
    // and hydration reads the raw JSON back — assert the JSON round-trip is byte-faithful.
    const bp: Blueprint = { ...sample(), origin: "local", team: team() };
    const restored = JSON.parse(JSON.stringify(bp)) as Blueprint;
    expect(restored.team).toEqual(team());
    // …and the coercion path (import / the planner's <blueprint> tag poll) keeps it too.
    expect(coerceBlueprint(restored)!.team).toEqual(team());
  });

  it("coerceTeam drops malformed entries and rejects non-object payloads", () => {
    expect(coerceTeam(undefined)).toBeUndefined();
    expect(coerceTeam("garbage")).toBeUndefined();
    expect(coerceTeam([1, 2])).toBeUndefined();
    const t = coerceTeam({
      positions: [
        { nodeId: "ok", kind: "agent" },
        { kind: "agent" },                    // no nodeId → dropped
        { nodeId: "weird", kind: "alien" },   // unknown kind → defaults to agent
        "junk",
      ],
      relationships: [
        { id: "r1", archetype: "manages", from: "ok", to: "weird" },
        { id: "r2", archetype: "manages", from: "ok" }, // no `to` → dropped
        null,
      ],
    });
    expect(t!.positions.map((p) => p.nodeId)).toEqual(["ok", "weird"]);
    expect(t!.positions[1].kind).toBe("agent");
    expect(t!.relationships.map((r) => r.id)).toEqual(["r1"]);
  });

  it("store: updateBlueprintMeta persists the team through `bsc blueprint set`", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    const id = useAppStore.getState().addBlueprint(); // a user blueprint (write-through eligible)
    vi.mocked(invoke).mockClear();
    useAppStore.getState().updateBlueprintMeta(id, { team: team() });
    const argsOf = (call: unknown[]) => (call[1] as { args?: string[] } | undefined)?.args;
    const set = vi.mocked(invoke).mock.calls.find(
      (call) => call[0] === "bsc" && JSON.stringify(argsOf(call)) === JSON.stringify(["blueprint", "set"]),
    );
    expect(set).toBeTruthy();
    const persisted = JSON.parse((set![1] as { stdin: string }).stdin) as Blueprint;
    expect(persisted.id).toBe(id);
    expect(persisted.team).toEqual(team()); // the team travels inside the blueprint JSON, verbatim
    useAppStore.getState().removeBlueprint(id);
  });

  it("store: duplicateBlueprint deep-copies the team (no shared graph objects with the source)", () => {
    // Seed the source directly (a minted id could collide with duplicate's same-ms Date.now id).
    const id = "bp-team-src";
    useAppStore.setState({
      blueprints: [...makeBlueprints(), { ...sample(), id, name: "Teamed", origin: "local" as const, team: team() }],
      activeBlueprintId: "default",
    });
    const nid = useAppStore.getState().duplicateBlueprint(id);
    const src = useAppStore.getState().blueprints.find((b) => b.id === id)!;
    const copy = useAppStore.getState().blueprints.find((b) => b.id === nid)!;
    expect(copy.team).toEqual(src.team);
    expect(copy.team).not.toBe(src.team);
    expect(copy.team!.positions[0]).not.toBe(src.team!.positions[0]);
    useAppStore.getState().removeBlueprint(nid);
    useAppStore.getState().removeBlueprint(id);
  });
});

describe("design contribution (#2606)", () => {
  // Same whitelist discipline as team/uiKit (#2450): `design` must be explicitly coerced or it's
  // silently stripped on every import/share round-trip → the reconciliation confirm-list (#2658) would
  // never fire. These guard that it survives.
  it("coerceBlueprint preserves design; a blueprint without one stays without the key", () => {
    const withDesign = coerceBlueprint({
      id: "x", name: "Designed", design: { categories: ["simulation", "analysis"], theme: "warm" },
      sections: [{ key: "discovery", name: "Discovery" }],
    });
    expect(withDesign!.design).toEqual({ categories: ["simulation", "analysis"], theme: "warm" });
    const without = coerceBlueprint({ id: "x", name: "Plain", sections: [{ key: "discovery", name: "Discovery" }] });
    expect("design" in without!).toBe(false);
  });

  it("drops an empty/garbage design, keeps a categories-only or theme-only one", () => {
    expect("design" in coerceBlueprint({ id: "x", name: "n", design: {}, sections: [{ key: "d", name: "D" }] })!).toBe(false);
    expect("design" in coerceBlueprint({ id: "x", name: "n", design: "junk", sections: [{ key: "d", name: "D" }] })!).toBe(false);
    expect(coerceBlueprint({ id: "x", name: "n", design: { categories: ["sim"] }, sections: [{ key: "d", name: "D" }] })!.design)
      .toEqual({ categories: ["sim"] });
    expect(coerceBlueprint({ id: "x", name: "n", design: { theme: "warm" }, sections: [{ key: "d", name: "D" }] })!.design)
      .toEqual({ theme: "warm" });
  });

  it("round-trips design through the share manifest (export/import)", () => {
    const bp: Blueprint = { ...sample(), design: { categories: ["simulation"], theme: "cool" } };
    const back = manifestToBlueprint(blueprintToManifest(bp));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.design).toEqual({ categories: ["simulation"], theme: "cool" });
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

describe("UI-kit pin (#2465)", () => {
  const pin = () => ({
    id: "acme/neon", version: "2.1.0",
    hash: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    source: "https://gist.github.com/acme/0123456789abcdef",
  });

  it("coerceBlueprint preserves the pin byte-faithfully; a blueprint without one stays without one", () => {
    const withPin = coerceBlueprint({
      id: "x", name: "Pinned", uiKit: pin(),
      sections: [{ key: "discovery", name: "Discovery" }],
    });
    expect(withPin!.uiKit).toEqual(pin());
    // No `uiKit` in the payload → the coerced blueprint carries NO uiKit key (optional field,
    // untouched behavior for existing blueprints — the #2450 whitelist lesson).
    const without = coerceBlueprint({ id: "x", name: "Plain", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(without).not.toBeNull();
    expect("uiKit" in without!).toBe(false);
  });

  it("round-trips the pin through the share manifest (export/import)", () => {
    const bp: Blueprint = { ...sample(), uiKit: pin() };
    const back = manifestToBlueprint(blueprintToManifest(bp));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.uiKit).toEqual(pin());
  });

  it("round-trips the pin through the `bsc blueprint` store serialization AND the poll path", () => {
    // Store: `bsc blueprint set` persists the blueprint verbatim; hydration reads raw JSON back.
    const bp: Blueprint = { ...sample(), origin: "local", uiKit: pin() };
    const restored = JSON.parse(JSON.stringify(bp)) as Blueprint;
    expect(restored.uiKit).toEqual(pin());
    // The poll path: the authoring session's `<blueprint>` tag goes through
    // coerceBlueprint(allowEmptySections) — the pin must survive it too.
    expect(coerceBlueprint(restored, { allowEmptySections: true })!.uiKit).toEqual(pin());
  });

  it("coerceUiKit requires id+version+hash (an unverifiable pin is dropped, not carried)", () => {
    expect(coerceUiKit(undefined)).toBeUndefined();
    expect(coerceUiKit("nope")).toBeUndefined();
    expect(coerceUiKit([])).toBeUndefined();
    expect(coerceUiKit({ id: "a/b", version: "1.0.0" })).toBeUndefined();          // no hash
    expect(coerceUiKit({ id: "a/b", hash: "h" })).toBeUndefined();                 // no version
    expect(coerceUiKit({ version: "1.0.0", hash: "h" })).toBeUndefined();          // no id
    // source is optional and dropped when empty/non-string.
    expect(coerceUiKit({ id: "a/b", version: "1.0.0", hash: "h" })).toEqual({ id: "a/b", version: "1.0.0", hash: "h" });
    expect(coerceUiKit({ id: "a/b", version: "1.0.0", hash: "h", source: 42 })).toEqual({ id: "a/b", version: "1.0.0", hash: "h" });
    expect(coerceUiKit(pin())).toEqual(pin());
    // A malformed pin never nulls the whole blueprint — it just imports unpinned.
    const bp = coerceBlueprint({ id: "x", name: "X", uiKit: { id: "a/b" }, sections: [{ key: "discovery", name: "Discovery" }] });
    expect(bp).not.toBeNull();
    expect("uiKit" in bp!).toBe(false);
  });

  it("coerceUiKit carries the paired themeId (#2489); a malformed one is dropped, not carried", () => {
    expect(coerceUiKit({ ...pin(), themeId: "soft" })).toEqual({ ...pin(), themeId: "soft" });
    expect(coerceUiKit({ ...pin(), themeId: "" })).toEqual(pin());
    expect(coerceUiKit({ ...pin(), themeId: 42 })).toEqual(pin());
    // The theme id rides the pin through a full blueprint round-trip: the share manifest
    // (export/import) AND the store-JSON + poll path (coerceBlueprint).
    const bp: Blueprint = { ...sample(), uiKit: { ...pin(), themeId: "warm" } };
    const back = manifestToBlueprint(blueprintToManifest(bp));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.uiKit).toEqual({ ...pin(), themeId: "warm" });
    const restored = coerceBlueprint(JSON.parse(JSON.stringify(bp)) as unknown, { allowEmptySections: true });
    expect(restored!.uiKit).toEqual({ ...pin(), themeId: "warm" });
  });

  it("store: updateBlueprintMeta persists the pin through `bsc blueprint set`", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    const id = useAppStore.getState().addBlueprint();
    vi.mocked(invoke).mockClear();
    useAppStore.getState().updateBlueprintMeta(id, { uiKit: pin() });
    const argsOf = (call: unknown[]) => (call[1] as { args?: string[] } | undefined)?.args;
    const set = vi.mocked(invoke).mock.calls.find(
      (call) => call[0] === "bsc" && JSON.stringify(argsOf(call)) === JSON.stringify(["blueprint", "set"]),
    );
    expect(set).toBeTruthy();
    const persisted = JSON.parse((set![1] as { stdin: string }).stdin) as Blueprint;
    expect(persisted.id).toBe(id);
    expect(persisted.uiKit).toEqual(pin()); // the pin travels inside the blueprint JSON, verbatim
    useAppStore.getState().removeBlueprint(id);
  });
});

describe("sound-kit pin (#3372)", () => {
  const spin = () => ({ id: "bsc/signal", version: "1.0.0", hash: "d".repeat(64), source: "https://gist.github.com/acme/s" });

  it("coerceBlueprint preserves the pin byte-faithfully; a blueprint without one stays without one", () => {
    const withPin = coerceBlueprint({
      id: "x", name: "Pinned", soundKit: spin(),
      sections: [{ key: "discovery", name: "Discovery" }],
    });
    expect(withPin!.soundKit).toEqual(spin());
    const without = coerceBlueprint({ id: "x", name: "Plain", sections: [{ key: "discovery", name: "Discovery" }] });
    expect("soundKit" in without!).toBe(false);
  });

  it("round-trips the pin through the share manifest AND the store-JSON + poll path", () => {
    const bp: Blueprint = { ...sample(), soundKit: spin() };
    const back = manifestToBlueprint(blueprintToManifest(bp));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.blueprint.soundKit).toEqual(spin());
    // `bsc blueprint set` persists verbatim; the poll path re-coerces — the pin must survive both.
    const restored = JSON.parse(JSON.stringify(bp)) as Blueprint;
    expect(coerceBlueprint(restored, { allowEmptySections: true })!.soundKit).toEqual(spin());
  });

  it("coerceSoundKit requires id+version+hash (an unverifiable pin is dropped, not carried)", () => {
    expect(coerceSoundKit(undefined)).toBeUndefined();
    expect(coerceSoundKit("nope")).toBeUndefined();
    expect(coerceSoundKit([])).toBeUndefined();
    expect(coerceSoundKit({ id: "a/b", version: "1.0.0" })).toBeUndefined();   // no hash
    expect(coerceSoundKit({ id: "a/b", hash: "h" })).toBeUndefined();          // no version
    expect(coerceSoundKit({ version: "1.0.0", hash: "h" })).toBeUndefined();   // no id
    // source is optional and dropped when empty/non-string; there is NO themeId twin.
    expect(coerceSoundKit({ id: "a/b", version: "1.0.0", hash: "h" })).toEqual({ id: "a/b", version: "1.0.0", hash: "h" });
    expect(coerceSoundKit({ id: "a/b", version: "1.0.0", hash: "h", source: 42 })).toEqual({ id: "a/b", version: "1.0.0", hash: "h" });
    expect(coerceSoundKit({ ...spin(), themeId: "soft" })).toEqual(spin());
    // A malformed pin never nulls the whole blueprint — it just imports unpinned.
    const bp = coerceBlueprint({ id: "x", name: "X", soundKit: { id: "a/b" }, sections: [{ key: "discovery", name: "Discovery" }] });
    expect(bp).not.toBeNull();
    expect("soundKit" in bp!).toBe(false);
  });

  it("store: updateBlueprintMeta persists the pin through `bsc blueprint set`", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    const id = useAppStore.getState().addBlueprint();
    vi.mocked(invoke).mockClear();
    useAppStore.getState().updateBlueprintMeta(id, { soundKit: spin() });
    const argsOf = (call: unknown[]) => (call[1] as { args?: string[] } | undefined)?.args;
    const set = vi.mocked(invoke).mock.calls.find(
      (call) => call[0] === "bsc" && JSON.stringify(argsOf(call)) === JSON.stringify(["blueprint", "set"]),
    );
    expect(set).toBeTruthy();
    const persisted = JSON.parse((set![1] as { stdin: string }).stdin) as Blueprint;
    expect(persisted.soundKit).toEqual(spin()); // the pin travels inside the blueprint JSON, verbatim
    useAppStore.getState().removeBlueprint(id);
  });
});

describe("fleet policy (#1854 Phase b / #2460)", () => {
  const policy = (): FleetPolicy => ({
    profile: "cautious-worker",
    flow: { autonomy: "checkpoint", push: "commit-only", trigger: "per-stage", gate: "soft" },
  });

  it("coerceBlueprint preserves the policy byte-faithfully; a blueprint without one stays without one", () => {
    const withPolicy = coerceBlueprint({
      id: "x", name: "Fleeted", fleetPolicy: policy(),
      sections: [{ key: "discovery", name: "Discovery" }],
    });
    expect(withPolicy!.fleetPolicy).toEqual(policy());
    // No `fleetPolicy` in the payload → the coerced blueprint carries NO fleetPolicy key
    // (optional field, untouched behavior for existing blueprints — the #2450 whitelist lesson).
    const without = coerceBlueprint({ id: "x", name: "Plain", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(without).not.toBeNull();
    expect("fleetPolicy" in without!).toBe(false);
  });

  it("survives coerce → export → import → coerce (the full share round-trip) byte-faithfully", () => {
    const first = coerceBlueprint({
      id: "x", name: "Fleeted", fleetPolicy: policy(),
      sections: [{ key: "discovery", name: "Discovery" }],
    })!;
    const back = manifestToBlueprint(blueprintToManifest(first));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.blueprint.fleetPolicy).toEqual(policy());
    // …and a second coercion (the planner's 2s `bsc plan blueprint get` poll re-coerces) keeps it.
    expect(coerceBlueprint(back.blueprint)!.fleetPolicy).toEqual(policy());
  });

  it("round-trips through the `bsc blueprint` store JSON AND the poll path", () => {
    const bp: Blueprint = { ...sample(), origin: "local", fleetPolicy: policy() };
    const restored = JSON.parse(JSON.stringify(bp)) as Blueprint;
    expect(restored.fleetPolicy).toEqual(policy());
    // The poll path: the authoring session's `<blueprint>` tag goes through
    // coerceBlueprint(allowEmptySections) — the policy must survive it too.
    expect(coerceBlueprint(restored, { allowEmptySections: true })!.fleetPolicy).toEqual(policy());
  });

  it("coerceFleetPolicy drops a malformed policy whole without nulling the blueprint", () => {
    expect(coerceFleetPolicy(undefined)).toBeUndefined();
    expect(coerceFleetPolicy("garbage")).toBeUndefined();
    expect(coerceFleetPolicy([1, 2])).toBeUndefined();
    // An informationless policy (neither field usable) carries nothing → treated as absent.
    expect(coerceFleetPolicy({})).toBeUndefined();
    expect(coerceFleetPolicy({ profile: 42, flow: "yolo" })).toBeUndefined();
    // profile-only / flow-only policies are valid (both fields optional in FleetPolicy).
    expect(coerceFleetPolicy({ profile: "p1" })).toEqual({ profile: "p1" });
    expect(coerceFleetPolicy({ flow: policy().flow })).toEqual({ flow: policy().flow });
    // A partial flow normalizes to a complete launch-safe flow — the same flowOrUndefined rule
    // the tag/fleet.json parsers apply; a flow naming no field is dropped.
    expect(coerceFleetPolicy({ profile: "p1", flow: { push: "commit-only" } }))
      .toEqual({ profile: "p1", flow: { ...DEFAULT_FLOW, push: "commit-only" } });
    expect(coerceFleetPolicy({ profile: "p1", flow: {} })).toEqual({ profile: "p1" });
    // A malformed policy never nulls the whole blueprint — it just imports policy-less.
    const bp = coerceBlueprint({ id: "x", name: "X", fleetPolicy: "broken", sections: [{ key: "discovery", name: "Discovery" }] });
    expect(bp).not.toBeNull();
    expect("fleetPolicy" in bp!).toBe(false);
  });

  it("store: updateBlueprintMeta persists the policy through `bsc blueprint set`", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    const id = useAppStore.getState().addBlueprint();
    vi.mocked(invoke).mockClear();
    useAppStore.getState().updateBlueprintMeta(id, { fleetPolicy: policy() });
    const argsOf = (call: unknown[]) => (call[1] as { args?: string[] } | undefined)?.args;
    const set = vi.mocked(invoke).mock.calls.find(
      (call) => call[0] === "bsc" && JSON.stringify(argsOf(call)) === JSON.stringify(["blueprint", "set"]),
    );
    expect(set).toBeTruthy();
    const persisted = JSON.parse((set![1] as { stdin: string }).stdin) as Blueprint;
    expect(persisted.id).toBe(id);
    expect(persisted.fleetPolicy).toEqual(policy()); // the policy travels inside the blueprint JSON, verbatim
    useAppStore.getState().removeBlueprint(id);
  });
});
